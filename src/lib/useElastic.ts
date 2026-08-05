import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogEntry } from './types'
import {
  ES_TENANTS, EsError, fetchErrorTypes, fetchServices, fetchVolume, searchLogs,
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

const MAX_LOGS = 500
/** Aggregations are expensive next to a tail query, so they run every Nth poll. */
const AGG_EVERY = 6

/**
 * Tails the configured Elastic data streams and keeps the rolling window the
 * dashboard renders from. Emits the same `LogEntry[]` shape as the demo
 * generator, so every section works unchanged.
 */
export function useElasticStream({ enabled, live, pollMs = 5000 }: {
  enabled: boolean
  live: boolean
  pollMs?: number
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

  const refresh = useCallback(() => {
    cursors.current = {}
    pollCount.current = 0
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
          const fresh = await searchLogs(
            t,
            { after: cursors.current[t.id], since: 'now-15m', size: 200 },
            ctrl.signal,
          )
          if (fresh.length) cursors.current[t.id] = fresh[0].timestamp

          if (!wantAggs) return { t, fresh, vol: null, svc: null, errs: null }

          // Aggregation failures must not take the tail down with them.
          const [vol, svc, errs] = await Promise.all([
            fetchVolume(t, 24, ctrl.signal).catch(() => null),
            fetchServices(t, 1, ctrl.signal).catch(() => null),
            fetchErrorTypes(t, 24, ctrl.signal).catch(() => null),
          ])
          return { t, fresh, vol, svc, errs }
        }))

        if (stopped) return

        const incoming = results.flatMap(r => r.fresh)
        if (incoming.length) {
          setLogs(prev => {
            const seen = new Set(prev.map(l => l.id))
            const merged = [...incoming.filter(l => !seen.has(l.id)), ...prev]
            merged.sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1))
            return merged.slice(0, MAX_LOGS)
          })
          setDocsSeen(n => n + incoming.length)
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
  }, [enabled, live, pollMs, nonce])

  return { status, error, logs, volume, services, errorTypes, latencyMs, lastPoll, docsSeen, refresh }
}
