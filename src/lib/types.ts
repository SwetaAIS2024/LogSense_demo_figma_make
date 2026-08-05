/** Shared domain types — imported by both the UI and the Elasticsearch adapter. */

export type Severity = 'CRITICAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

/** Four LoB domains. */
export type DomainId = 'mps' | 'mrd' | 'pis' | 'ssa'
export type DomainFilter = DomainId

export interface LogEntry {
  id: string
  timestamp: string
  domain: DomainId
  severity: Severity
  service: string
  message: string
  traceId: string
  duration?: number
  statusCode?: number
  /** Present on Elastic-sourced rows: the backing index/data stream. */
  index?: string
}

/** A tenant: one delivery team with its own estate, SLO and data-handling policy. */
export interface DomainDef {
  id: DomainId
  label: string
  short: string
  team: string
  icon: string
  /** Share of the platform-wide event volume (demo generation only). */
  share: number
  services: string[]
  messages: Record<Severity, string[]>
  /** The unit of harm this team is judged on — riders, journeys, transactions. */
  impactUnit: string
  slo: { name: string; target: string; attainment: number; burn: number }
  policy: { residency: string; pii: string; retention: string; regime: string }
  /** Elastic-backed tenants only: the data stream or index pattern behind them. */
  index?: string
}
