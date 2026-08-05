/**
 * Elasticsearch adapter.
 *
 * The whole dashboard derives from `LogEntry[]` plus a few aggregations, so the
 * integration surface is deliberately small: map ECS documents onto `LogEntry`,
 * and express the four rollups the UI needs as aggregations run in the cluster
 * rather than over documents pulled into the browser.
 *
 * Auth: by default requests go to `/es`, which the Vite dev server proxies to
 * the cluster and where it injects the API key. That keeps the credential out
 * of the browser bundle. Setting VITE_ES_URL bypasses the proxy and talks to
 * the cluster directly — only do that against a CORS-enabled cluster with a
 * read-only, index-scoped API key.
 */

import type { DomainId, LogEntry, Severity } from './types'

// ─── Configuration ────────────────────────────────────────────────────────────

const env = import.meta.env

export const ES_BASE = (env.VITE_ES_URL as string | undefined)?.replace(/\/$/, '') || '/es'
/** Only set in direct-to-cluster mode; the proxy path leaves this empty. */
const ES_API_KEY = (env.VITE_ES_API_KEY as string | undefined) || ''

/** Elastic-backed tenants. Index patterns are overridable without a rebuild. */
export const ES_TENANTS: { id: DomainId; index: string; label: string; team: string; short: string; icon: string }[] = [
  {
    id: 'mps',
    index: (env.VITE_ES_INDEX_MPS as string | undefined) || 'logs-mps-*',
    label: 'MPS', team: 'MPS Platform', short: 'MPS', icon: '⛃',
  },
  {
    id: 'mrd',
    index: (env.VITE_ES_INDEX_MRD as string | undefined) || 'logs-mrd-*',
    label: 'MRD', team: 'MRD Platform', short: 'MRD', icon: '⛂',
  },
]

export const ES_TENANT_IDS = ES_TENANTS.map(t => t.id)

/**
 * ECS field names. If your streams use a different shape, this object is the
 * only place that needs to change — every query and mapper reads from it.
 */
export const FIELDS = {
  timestamp: '@timestamp',
  severity: 'log.level',
  service: 'service.name',
  message: 'message',
  traceId: 'trace.id',
  /** ECS stores this in nanoseconds; `mapDoc` converts to ms. */
  duration: 'event.duration',
  statusCode: 'http.response.status_code',
  errorType: 'error.type',
}

// ─── Transport ────────────────────────────────────────────────────────────────

export class EsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'EsError'
  }
}

async function esFetch(path: string, body: unknown, signal?: AbortSignal) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ES_API_KEY) headers.Authorization = `ApiKey ${ES_API_KEY}`

  const res = await fetch(`${ES_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new EsError(
      `Elasticsearch ${res.status}: ${text.slice(0, 300) || res.statusText}`,
      res.status,
    )
  }
  return res.json()
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

/** Flattened or nested — ECS documents arrive both ways depending on the shipper. */
function pick(src: any, path: string): any {
  if (src == null) return undefined
  if (src[path] !== undefined) return src[path]
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), src)
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  emerg: 'CRITICAL', alert: 'CRITICAL', crit: 'CRITICAL', critical: 'CRITICAL', fatal: 'CRITICAL',
  err: 'ERROR', error: 'ERROR', severe: 'ERROR',
  warn: 'WARN', warning: 'WARN', notice: 'WARN',
  info: 'INFO', information: 'INFO', informational: 'INFO',
  debug: 'DEBUG', trace: 'DEBUG', verbose: 'DEBUG',
}

export function normalizeSeverity(raw: unknown): Severity {
  if (typeof raw === 'number') {
    // Syslog numeric levels.
    return raw <= 2 ? 'CRITICAL' : raw === 3 ? 'ERROR' : raw === 4 ? 'WARN' : raw === 7 ? 'DEBUG' : 'INFO'
  }
  const k = String(raw ?? '').trim().toLowerCase()
  return SEVERITY_ALIASES[k] ?? 'INFO'
}

export function mapDoc(hit: any, domain: DomainId): LogEntry {
  const src = hit._source ?? {}
  const durationNs = Number(pick(src, FIELDS.duration))
  return {
    id: hit._id ?? Math.random().toString(36).slice(2, 10),
    timestamp: String(pick(src, FIELDS.timestamp) ?? new Date().toISOString()),
    domain,
    severity: normalizeSeverity(pick(src, FIELDS.severity)),
    service: String(pick(src, FIELDS.service) ?? 'unknown'),
    message: String(pick(src, FIELDS.message) ?? ''),
    traceId: String(pick(src, FIELDS.traceId) ?? ''),
    duration: Number.isFinite(durationNs) ? Math.round(durationNs / 1e6) : undefined,
    statusCode: Number(pick(src, FIELDS.statusCode)) || undefined,
    index: hit._index,
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export interface StreamQuery {
  /** ISO timestamp; only documents strictly newer are returned. */
  after?: string
  /** Relative window used on the first poll, e.g. `now-15m`. */
  since?: string
  size?: number
  severities?: Severity[]
  service?: string
  /** Free text, matched against the message field. */
  search?: string
}

function timeFilter(q: StreamQuery) {
  return q.after
    ? { range: { [FIELDS.timestamp]: { gt: q.after } } }
    : { range: { [FIELDS.timestamp]: { gte: q.since ?? 'now-15m' } } }
}

function buildQuery(q: StreamQuery) {
  const filter: any[] = [timeFilter(q)]
  if (q.service) filter.push({ term: { [`${FIELDS.service}.keyword`]: q.service } })
  if (q.severities?.length) {
    // Match however the shipper cased it.
    filter.push({
      bool: {
        should: q.severities.flatMap(s => [
          { term: { [FIELDS.severity]: s.toLowerCase() } },
          { term: { [FIELDS.severity]: s } },
        ]),
        minimum_should_match: 1,
      },
    })
  }
  const must = q.search
    ? [{ match_phrase_prefix: { [FIELDS.message]: q.search } }]
    : []
  return { bool: { filter, ...(must.length ? { must } : {}) } }
}

/** Newest-first page of logs for one tenant. */
export async function searchLogs(
  tenant: { id: DomainId; index: string },
  q: StreamQuery = {},
  signal?: AbortSignal,
): Promise<LogEntry[]> {
  const body = {
    size: q.size ?? 200,
    sort: [{ [FIELDS.timestamp]: 'desc' }],
    track_total_hits: false,
    query: buildQuery(q),
  }
  const json = await esFetch(`/${encodeURIComponent(tenant.index)}/_search`, body, signal)
  return (json.hits?.hits ?? []).map((h: any) => mapDoc(h, tenant.id))
}

export interface VolumeBucket { time: string; total: number; errors: number; warns: number }

/** Hourly event volume with an error/warn split, computed in the cluster. */
export async function fetchVolume(
  tenant: { id: DomainId; index: string },
  hours = 24,
  signal?: AbortSignal,
): Promise<VolumeBucket[]> {
  const body = {
    size: 0,
    query: { bool: { filter: [{ range: { [FIELDS.timestamp]: { gte: `now-${hours}h` } } }] } },
    aggs: {
      over_time: {
        date_histogram: { field: FIELDS.timestamp, fixed_interval: '1h', min_doc_count: 0 },
        aggs: { by_level: { terms: { field: FIELDS.severity, size: 12 } } },
      },
    },
  }
  const json = await esFetch(`/${encodeURIComponent(tenant.index)}/_search`, body, signal)
  return (json.aggregations?.over_time?.buckets ?? []).map((b: any) => {
    let errors = 0
    let warns = 0
    for (const lb of b.by_level?.buckets ?? []) {
      const sev = normalizeSeverity(lb.key)
      if (sev === 'CRITICAL' || sev === 'ERROR') errors += lb.doc_count
      if (sev === 'WARN') warns += lb.doc_count
    }
    return {
      time: new Date(b.key).toISOString().slice(11, 16),
      total: b.doc_count,
      errors,
      warns,
    }
  })
}

export interface ServiceRollup {
  service: string
  events: number
  errors: number
  errRate: number
  p99: number
}

/** Per-service health: volume, error rate and p99 latency, in one round trip. */
export async function fetchServices(
  tenant: { id: DomainId; index: string },
  hours = 1,
  signal?: AbortSignal,
): Promise<ServiceRollup[]> {
  const body = {
    size: 0,
    query: { bool: { filter: [{ range: { [FIELDS.timestamp]: { gte: `now-${hours}h` } } }] } },
    aggs: {
      by_service: {
        terms: { field: `${FIELDS.service}.keyword`, size: 50, order: { _count: 'desc' } },
        aggs: {
          errors: {
            filter: {
              bool: {
                should: ['error', 'critical', 'fatal', 'ERROR', 'CRITICAL'].map(v => ({ term: { [FIELDS.severity]: v } })),
                minimum_should_match: 1,
              },
            },
          },
          latency: { percentiles: { field: FIELDS.duration, percents: [99] } },
        },
      },
    },
  }
  const json = await esFetch(`/${encodeURIComponent(tenant.index)}/_search`, body, signal)
  return (json.aggregations?.by_service?.buckets ?? []).map((b: any) => {
    const errors = b.errors?.doc_count ?? 0
    const p99ns = b.latency?.values?.['99.0']
    return {
      service: String(b.key),
      events: b.doc_count,
      errors,
      errRate: b.doc_count ? Number(((errors / b.doc_count) * 100).toFixed(1)) : 0,
      p99: Number.isFinite(p99ns) ? Math.round(p99ns / 1e6) : 0,
    }
  })
}

export interface ErrorTypeBucket { name: string; count: number; pct: number }

/** Error taxonomy for a tenant, from `error.type`. */
export async function fetchErrorTypes(
  tenant: { id: DomainId; index: string },
  hours = 24,
  signal?: AbortSignal,
): Promise<ErrorTypeBucket[]> {
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [{ range: { [FIELDS.timestamp]: { gte: `now-${hours}h` } } }],
        should: ['error', 'critical', 'fatal', 'ERROR', 'CRITICAL'].map(v => ({ term: { [FIELDS.severity]: v } })),
        minimum_should_match: 1,
      },
    },
    aggs: { by_type: { terms: { field: `${FIELDS.errorType}.keyword`, size: 7, missing: 'Uncategorised' } } },
  }
  const json = await esFetch(`/${encodeURIComponent(tenant.index)}/_search`, body, signal)
  const buckets = json.aggregations?.by_type?.buckets ?? []
  const total = buckets.reduce((n: number, b: any) => n + b.doc_count, 0) || 1
  return buckets.map((b: any) => ({
    name: String(b.key),
    count: b.doc_count,
    pct: Number(((b.doc_count / total) * 100).toFixed(1)),
  }))
}

/** Cheap reachability probe used by the connection pill. */
export async function ping(index: string, signal?: AbortSignal): Promise<number> {
  const t0 = performance.now()
  await esFetch(`/${encodeURIComponent(index)}/_search`, { size: 0, track_total_hits: false }, signal)
  return Math.round(performance.now() - t0)
}
