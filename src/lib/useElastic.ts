import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogEntry } from './types'
import {
  ES_TENANTS, EsError, fetchErrorTypes, fetchServices, fetchVolume, searchLogs, searchAllLogs,
  type ErrorTypeBucket, type ServiceRollup, type VolumeBucket,
} from './elastic'

export type EsStatus = 'off' | 'connecting' | 'live' | 'error'

export interface EsState {
  status: EsStatus
  error: string | null
  logs: LogEntry[]
  /** Keyed by tenant id. */
  volume: Record<string, VolumeBucket[]>
  services: Record<string, ServiceRollup[]>
  errorTypes: Record<string, ErrorTypeBucket[]>
  latencyMs: number | null
  lastPoll: string | null
  docsSeen: number
  refresh: () => void
}

/** Bytes per LogEntry (strings are UTF-16 in V8, ~486 bytes average for MPS/MRD log shape). */
const BYTES_PER_ENTRY = 500
/** Hard ceiling for browsers without performance.memory (Firefox, Safari). */
const FALLBACK_MAX = 500000
/** Max entries kept in React state — limits re-render cost; full dataset lives in the allLogs ref. */
const RENDER_MAX = 10000

/** Returns how many more log entries the browser can safely hold (~70 % of free heap). */
function heapBudget(current: number): number {
  const mem = (performance as any).memory as { usedJSHeapSize: number; jsHeapSizeLimit: number } | undefined
  if (!mem) return FALLBACK_MAX
  const freeBytes = mem.jsHeapSizeLimit - mem.usedJSHeapSize
  const canAdd = Math.floor((freeBytes * 0.7) / BYTES_PER_ENTRY)
  return current + Math.max(0, canAdd)
}
/** Aggregations are expensive next to a tail query, so they run every Nth poll. */
const AGG_EVERY = 6

/**
 * Tails the configured Elastic data streams and keeps the rolling window the
 * dashboard renders from. Emits the same `LogEntry[]` shape as the demo
 * generator, so every section works unchanged.
 */
export function useElasticStream({ enabled, live, pollMs = 5000, since = 'now-24h', until, aggHours = 24 }: {
  enabled: boolean
  live: boolean
  pollMs?: number
  /** Elasticsearch date-math expression for the lower bound of every query, e.g. 'now-24h' or '2026-05-01T00:00:00Z'. */
  since?: string
  /** Optional upper bound; leave undefined to use 'now'. */
  until?: string
  /** Hours span used for aggregation queries (volume, services, error types). */
  aggHours?: number
}): EsState {
  const [status, setStatus] = useState<EsStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [volume, setVolume] = useState<Record<string, VolumeBucket[]>>({})
  const [services, setServices] = useState<Record<string, ServiceRollup[]>>({})
  const [errorTypes, setErrorTypes] = useState<Record<string, ErrorTypeBucket[]>>({})
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [lastPoll, setLastPoll] = useState<string | null>(null)
  const [docsSeen, setDocsSeen] = useState(0)
  const [nonce, setNonce] = useState(0)

  /** Newest timestamp seen per tenant — the cursor for the next tail query. */
  const cursors = useRef<Record<string, string | undefined>>({})
  const pollCount = useRef(0)

  /** Full dataset off the render cycle — used by aggregations without causing re-renders. */
  const allLogs = useRef<LogEntry[]>([])

  const refresh = useCallback(() => {
    cursors.current = {}
    pollCount.current = 0
    allLogs.current = []
    setLogs([])
    setNonce(n => n + 1)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      setError(null)
      return
    }

    const ctrl = new AbortController()
    let timer: number | undefined
    let stopped = false

    const poll = async () => {
      const t0 = performance.now()
      try {
        const wantAggs = pollCount.current % AGG_EVERY === 0

        const results = await Promise.all(ES_TENANTS.map(async t => {
          // First load or after refresh: stream all pages, updating state after each.
          // Subsequent polls use a cursor to only fetch new documents (live tail).
          const hasCursor = !!cursors.current[t.id]
          if (!hasCursor) {
            let pageBuffer: LogEntry[] = []
            let flushTimer: ReturnType<typeof setTimeout> | undefined

            const flush = () => {
              if (!pageBuffer.length || stopped) return
              const batch = pageBuffer.splice(0)
              const seen = new Set(allLogs.current.map(l => l.id))
              const incoming = batch.filter(l => !seen.has(l.id))
              allLogs.current = [...incoming, ...allLogs.current]
                .sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1))
                .slice(0, heapBudget(0))
              setLogs(allLogs.current.slice(0, RENDER_MAX))
              setDocsSeen(allLogs.current.length)
              setStatus('live')
            }

            await searchAllLogs(t, { since }, (page) => {
              if (stopped) return
              if (page.length) cursors.current[t.id] = page[0].timestamp
              pageBuffer.push(...page)
              if (flushTimer) clearTimeout(flushTimer)
              flushTimer = setTimeout(flush, 500)
            }, ctrl.signal)

            if (flushTimer) clearTimeout(flushTimer)
            flush()
            return { t, fresh: [], vol: null, svc: null, errs: null }
          }
          const fresh = await searchLogs(t, { after: cursors.current[t.id], since, size: 1000 }, ctrl.signal)
          if (fresh.length) cursors.current[t.id] = fresh[0].timestamp

          if (!wantAggs) return { t, fresh, vol: null, svc: null, errs: null }

          // Aggregation failures must not take the tail down with them.
          const [vol, svc, errs] = await Promise.all([
            fetchVolume(t, aggHours, ctrl.signal).catch(() => null),
            fetchServices(t, aggHours, ctrl.signal).catch(() => null),
            fetchErrorTypes(t, aggHours, ctrl.signal).catch(() => null),
          ])
          return { t, fresh, vol, svc, errs }
        }))

        if (stopped) return

        const incoming = results.flatMap(r => r.fresh)
        if (incoming.length) {
          const seen = new Set(allLogs.current.map(l => l.id))
          const novel = incoming.filter(l => !seen.has(l.id))
          allLogs.current = [...novel, ...allLogs.current]
            .sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1))
            .slice(0, heapBudget(0))
          setLogs(allLogs.current.slice(0, RENDER_MAX))
          setDocsSeen(allLogs.current.length)
        }

        for (const r of results) {
          if (r.vol) setVolume(v => ({ ...v, [r.t.id]: r.vol! }))
          if (r.svc) setServices(s => ({ ...s, [r.t.id]: r.svc! }))
          if (r.errs) setErrorTypes(e => ({ ...e, [r.t.id]: r.errs! }))
        }

        pollCount.current++
        setLatencyMs(Math.round(performance.now() - t0))
        setLastPoll(new Date().toISOString().slice(11, 19))
        setStatus('live')
        setError(null)
      } catch (err) {
        if (stopped || (err as Error).name === 'AbortError') return
        setStatus('error')
        setError(
          err instanceof EsError
            ? err.message
            : `Cannot reach Elasticsearch at the configured endpoint — ${(err as Error).message}`,
        )
      } finally {
        if (!stopped && live) timer = window.setTimeout(poll, pollMs)
      }
    }

    setStatus('connecting')
    poll()

    return () => {
      stopped = true
      ctrl.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [enabled, live, pollMs, since, until, aggHours, nonce])

  return { status, error, logs, volume, services, errorTypes, latencyMs, lastPoll, docsSeen, refresh }
}
