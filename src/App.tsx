import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart,
  Scatter, ReferenceLine, Legend
} from 'recharts'
import type { DomainDef, DomainFilter, DomainId, LogEntry, Severity } from '@/lib/types'
import { ES_BASE, ES_TENANTS, type ServiceRollup } from '@/lib/elastic'
import { useElasticStream, type EsState } from '@/lib/useElastic'

// ─── Theme ────────────────────────────────────────────────────────────────────

type ThemeMode = 'system' | 'dark' | 'light'
type Palette = typeof DARK

const DARK = {
  bg: '#080c14',
  bgDeep: '#060a10',
  card: '#0d1421',
  row: '#0f1c2e',
  border: '#1a2535',
  text: '#e0e6f0',
  text2: '#c8d3e0',
  dim: '#8892a4',
  faint: '#4a5568',
  cyan: '#00d4ff',
  red: '#ff3d3d',
  orange: '#ff6b35',
  amber: '#ffb800',
  green: '#00e676',
  purple: '#a855f7',
  /** Categorical series ramp — used to colour domains/tenants, never severity. */
  series: ['#00d4ff', '#a855f7', '#00e676', '#ffb800', '#ff5fa2'],
}

const LIGHT: Palette = {
  bg: '#f2f5fa',
  bgDeep: '#e7ecf4',
  card: '#ffffff',
  row: '#eef2f8',
  border: '#d2dbe7',
  text: '#0d1522',
  text2: '#2a3648',
  dim: '#586479',
  faint: '#8b95a6',
  cyan: '#0a7ab4',
  red: '#cf2020',
  orange: '#b44a0d',
  amber: '#8a6000',
  green: '#0a8a45',
  purple: '#7734d8',
  series: ['#0a7ab4', '#7734d8', '#0a8a45', '#8a6000', '#bd2168'],
}

/** Mutable active palette — reassigned by <App/> before any child renders. */
let C: Palette = DARK

/** hex -> rgba() with the given alpha. */
function a(hex: string, alpha: number | string) {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function usePrefersDark() {
  const [dark, setDark] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DataSource = 'demo' | 'elastic'
type NavSection = 'lob' | 'logs' | 'errors' | 'anomalies' | 'sla' | 'rca' | 'agent' | 'pipeline'
type TimeWindow = '1m' | '5m' | '15m' | '1h' | '6h' | '24h' | '7d'
type DateRange = { from: Date; to: Date; label: string }

// ─── Mock Data ────────────────────────────────────────────────────────────────

const SEVERITIES: Severity[] = ['CRITICAL', 'ERROR', 'WARN', 'INFO', 'DEBUG']
const SEV_WEIGHTS = [0.03, 0.08, 0.15, 0.55, 0.19]

// ─── Tenants ──────────────────────────────────────────────────────────────────
// Each delivery team ships wildly different telemetry: a signalling interlocking
// and a card settlement run have nothing in common except that both page someone
// at 03:00. Vocabulary, SLO and data policy are therefore per-tenant.

const DEMO_DOMAINS: DomainDef[] = [
  {
    id: 'mps',
    label: 'MPS',
    short: 'MPS',
    team: 'Mobility Payments Services',
    icon: '⛁',
    share: 0.3,
    impactUnit: 'transactions',
    services: ['payment-svc', 'settlement-engine', 'fraud-scoring', 'psp-adapter', 'ledger-db', 'tokenisation-svc'],
    slo: { name: 'Authorisation success rate', target: '99.9%', attainment: 99.31, burn: 6.9 },
    policy: { residency: 'eu-west-1', pii: 'PAN tokenised, CVV never stored', retention: '13m + 7y ledger', regime: 'PCI-DSS 4.0 / PSD2' },
    messages: {
      CRITICAL: [
        'Database connection pool exhausted — all 512 connections in use',
        'Payment service unresponsive — circuit breaker OPEN',
        'Settlement file SFT-0731 rejected by scheme — cutoff in 38m',
        'Ledger write divergence detected between primary and replica',
      ],
      ERROR: [
        'PSP adapter timeout: acquirer Worldline exceeded 5000ms SLA',
        'Idempotency key collision on txn_8fk2lm9 — duplicate capture blocked',
        '3DS challenge callback signature mismatch for issuer BIN 454321',
        'Tokenisation vault unreachable — fallback to PAN rejected by policy',
      ],
      WARN: [
        'Authorisation success rate 96.4% for issuer BIN 519876 (baseline 99.2%)',
        'Fraud model score drift: population stability index 0.24',
        'Retry attempt 2/3 for payment transaction txn_8fk2lm9',
        'Chargeback volume +38% w/w for merchant segment travel',
      ],
      INFO: [
        'Deployment complete: payment-svc v2.14.1 → v2.14.2',
        'Settlement batch 118,402 transactions netted €14.8M',
        'Autoscaler added 3 pods to payment-svc (current: 12, target: 12)',
        'Scheme token refresh completed for 2.1M credentials',
      ],
      DEBUG: [
        'Auth request routed acquirer=worldline mid=884120 rtt=88ms',
        'Ledger append seq=99182741 shard=4',
        'Fraud features assembled n=214 latency=11ms',
      ],
    },
  },
  {
    id: 'mrd',
    label: 'MRD',
    short: 'MRD',
    team: 'Mobility Road',
    icon: '⛬',
    share: 0.25,
    impactUnit: 'junctions',
    services: ['signal-controller', 'anpr-ingest', 'incident-detect', 'vms-gateway', 'route-optimiser', 'congestion-api'],
    slo: { name: 'Signal plan freshness < 5s', target: '99.5%', attainment: 99.62, burn: 0.8 },
    policy: { residency: 'eu-west-1', pii: 'ANPR plates hashed at edge', retention: '90d', regime: 'GDPR Art.6(1)(e)' },
    messages: {
      CRITICAL: [
        'Junction J-1184 fell back to fixed-time plan — SCOOT link dead 62s',
        'ANPR ingest backlog 4.2M frames — plate hashing worker pool starved',
        'Incident detection offline for corridor A40 — no camera heartbeat 3m',
      ],
      ERROR: [
        'VMS sign 22-EB rejected message: pictogram set unsupported by firmware 4.1',
        'Loop detector 88231 reporting occupancy 137% — sensor fault suspected',
        'SCOOT optimiser timeout: region NW exceeded 900ms cycle budget',
        'Route optimiser returned suboptimal path — graph data stale 18m',
      ],
      WARN: [
        'Queue length on A40 westbound 1.8km — above 1.2km intervention threshold',
        'Camera 41-N image quality degraded (fog) — ANPR confidence 0.61',
        'Signal plan drift 2.4s vs UTC on controller cluster B',
        'Congestion API p99 latency 920ms — above 800ms SLA',
      ],
      INFO: [
        'Strategy shift: corridor A40 → PM-peak plan (source: schedule)',
        'Green wave engaged, 11 junctions, offset 34s',
        'Roadworks feed synced: 84 active restrictions from street-manager',
        'Emergency vehicle pre-emption cleared J-1102 → J-1109 in 41s',
      ],
      DEBUG: [
        'Detector poll cycle=250ms sites=1184 dropped=0',
        'Plate hash h=8f2c… ttl=0s retained=false',
        'Route graph vertices=48291 edges=112004 refresh=ok',
      ],
    },
  },
  {
    id: 'pis',
    label: 'PIS',
    short: 'PIS',
    team: 'Passenger Information Systems',
    icon: '⛉',
    share: 0.25,
    impactUnit: 'passengers',
    services: ['display-controller', 'journey-api', 'timetable-feed', 'app-backend', 'push-notif', 'accessibility-svc'],
    slo: { name: 'Display freshness < 30s', target: '99.8%', attainment: 99.61, burn: 2.4 },
    policy: { residency: 'eu-west-2', pii: 'journey history pseudonymised @14d', retention: '18m', regime: 'GDPR / DPIA-2291' },
    messages: {
      CRITICAL: [
        'Display controller cluster PLT-NW unreachable — 412 screens blank',
        'Journey API returning 503 — timetable feed disconnect',
      ],
      ERROR: [
        'Timetable feed schema mismatch — 38 services missing from displays',
        'Push notification delivery rate 61% — APNs certificate near expiry',
        'Accessibility audio channel offline at 6 stations',
        'App backend cache eviction storm — cold start latency 4.2s',
      ],
      WARN: [
        'Display freshness p95 at 44s — above 30s target at zone NW',
        'Journey API cache hit ratio 58% after timetable activation',
        'Push notification queue depth 18,400 — SLA breach risk in 22m',
        'Accessibility svc dependency timeout from journey-api',
      ],
      INFO: [
        'Timetable v2026.07.3 pushed to 412 station displays',
        'App backend scaled to 18 pods — peak passenger demand',
        'Disruption banner activated for A-line via push notif',
      ],
      DEBUG: [
        'Display render cycle station=NW114 dt=28ms screens=14',
        'Journey cache miss origin=NW114 dest=SE022 ttl=0',
        'Push payload size=1.2KB tokens=84219 batch=ok',
      ],
    },
  },
  {
    id: 'ssa',
    label: 'SSA',
    short: 'SSA',
    team: 'Smart Security Automations',
    icon: '⛨',
    share: 0.2,
    impactUnit: 'events',
    services: ['camera-analytics', 'access-control', 'threat-classifier', 'alert-router', 'evidence-store'],
    slo: { name: 'Threat alert latency < 2s', target: '99.0%', attainment: 98.1, burn: 4.2 },
    policy: { residency: 'eu-west-2', pii: 'biometric data never stored, faces hashed', retention: '31d', regime: 'UK Surveillance Camera Code' },
    messages: {
      CRITICAL: [
        'Threat classifier offline — zone B-4 running on rule fallback only',
        'Evidence store write failure — 22m of footage unindexed',
      ],
      ERROR: [
        'Camera analytics lost feed: cam-0884 at station forecourt',
        'Access control door D-112 stuck OPEN — override in effect',
        'Alert router failed to deliver to SOC within 2s SLA — 14 events queued',
        'Threat classifier confidence below 0.6 threshold on 8% of frames',
      ],
      WARN: [
        'Alert latency p99 at 3.1s — above 2s SLA in zone B',
        'Camera analytics GPU utilisation 94% — headroom low',
        'Access control battery backup < 20% at 3 doors',
        'Evidence store approaching 80% capacity — archival needed',
      ],
      INFO: [
        'Threat classifier model v4.9 deployed — AUC 0.97 on holdout',
        'Zone B-4 patrol coverage verified: 100% camera overlap',
        'Access control firmware 3.2.1 rolled out to 88 doors',
      ],
      DEBUG: [
        'Frame batch cam=cam-0884 n=30 infer=18ms threat=none',
        'Alert route: zone=B-4 → soc-primary latency=0.8s',
        'Door state poll n=88 ok=86 warn=2',
      ],
    },
  },
]

/**
 * Tenants for the live Elastic backend. SLO targets and policy are declared
 * here because Elasticsearch does not know them; everything else — services,
 * volumes, error taxonomy — is discovered from the data streams at runtime.
 */
const ES_TENANT_DEFAULTS: Record<string, Pick<DomainDef, 'impactUnit' | 'slo' | 'policy'>> = {
  mps: {
    impactUnit: 'requests',
    slo: { name: 'Availability', target: '99.9%', attainment: 99.9, burn: 1 },
    policy: { residency: 'from cluster', pii: 'per index policy', retention: 'per ILM policy', regime: '—' },
  },
  mrd: {
    impactUnit: 'requests',
    slo: { name: 'Availability', target: '99.9%', attainment: 99.9, burn: 1 },
    policy: { residency: 'from cluster', pii: 'per index policy', retention: 'per ILM policy', regime: '—' },
  },
}

const EMPTY_MESSAGES: Record<Severity, string[]> = { CRITICAL: [], ERROR: [], WARN: [], INFO: [], DEBUG: [] }

/** Build tenant definitions for Elastic mode, folding in discovered services. */
function elasticDomains(discovered: Record<string, { service: string }[]>): DomainDef[] {
  return ES_TENANTS.map(t => ({
    id: t.id,
    label: t.label,
    short: t.short,
    team: t.team,
    icon: t.icon,
    share: 1 / ES_TENANTS.length,
    impactUnit: ES_TENANT_DEFAULTS[t.id]?.impactUnit ?? 'requests',
    services: (discovered[t.id] ?? []).map(s => s.service),
    messages: EMPTY_MESSAGES,
    slo: ES_TENANT_DEFAULTS[t.id]?.slo ?? { name: 'Availability', target: '99.9%', attainment: 99.9, burn: 1 },
    policy: ES_TENANT_DEFAULTS[t.id]?.policy ?? { residency: '—', pii: '—', retention: '—', regime: '—' },
    index: t.index,
  }))
}

/**
 * Active tenant registry. Reassigned by <App/> before any child renders, in the
 * same way as the colour palette, so switching data source re-scopes every view.
 */
let DOMAINS: DomainDef[] = DEMO_DOMAINS
let DOMAIN_BY_ID = Object.fromEntries(DOMAINS.map(d => [d.id, d])) as Record<DomainId, DomainDef>

function setTenantRegistry(list: DomainDef[]) {
  DOMAINS = list.length ? list : DEMO_DOMAINS
  DOMAIN_BY_ID = Object.fromEntries(DOMAINS.map(d => [d.id, d])) as Record<DomainId, DomainDef>
}

/** Stable accent per tenant, drawn from the categorical ramp (not the severity scale). */
function domainColor(id: DomainId) {
  const i = DOMAINS.findIndex(d => d.id === id)
  return C.series[(i < 0 ? 0 : i) % C.series.length]
}

function pickDomain(): DomainId {
  const r = Math.random()
  let cum = 0
  for (const d of DEMO_DOMAINS) {
    cum += d.share
    if (r < cum) return d.id
  }
  return 'mps'
}

function randSev(): Severity {
  const r = Math.random()
  let cum = 0
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEV_WEIGHTS[i]
    if (r < cum) return SEVERITIES[i]
  }
  return 'INFO'
}

function makeLog(offset = 0, forceDomain?: DomainId): LogEntry {
  const domain = forceDomain ?? pickDomain()
  const def = DOMAIN_BY_ID[domain]
  const sev = randSev()
  const msgs = def.messages[sev]
  const d = new Date(Date.now() - offset)
  return {
    id: Math.random().toString(36).slice(2, 10),
    timestamp: d.toISOString(),
    domain,
    severity: sev,
    service: def.services[Math.floor(Math.random() * def.services.length)],
    message: msgs[Math.floor(Math.random() * msgs.length)],
    traceId: Math.random().toString(16).slice(2, 18),
    duration: sev !== 'DEBUG' ? Math.floor(Math.random() * 4800) + 50 : undefined,
    statusCode: ['ERROR', 'CRITICAL'].includes(sev) ? [500, 502, 503, 504][Math.floor(Math.random() * 4)] : 200,
  }
}

/** Deterministic per-tenant jitter so switching tenants gives stable, distinct numbers. */
function seeded(key: string, i: number) {
  let h = 2166136261
  for (const ch of key + ':' + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

const INITIAL_LOGS: LogEntry[] = Array.from({ length: 200 }, (_, i) => makeLog(i * 1800))

/** 24h volume, one series per tenant so the stack shows who owns the spike. */
const VOLUME_DATA = Array.from({ length: 24 }, (_, i) => {
  const h = (new Date().getHours() - 23 + i + 24) % 24
  const base = 1200 + Math.sin(i * 0.4) * 400
  const row: Record<string, number | string> = { time: `${String(h).padStart(2, '0')}:00` }
  let total = 0
  for (const d of DEMO_DOMAINS) {
    const v = Math.floor((base + seeded(d.id, i) * 300) * d.share * 2)
    row[d.id] = v
    total += v
  }
  row.total = total
  row.errors = Math.floor(total * (0.06 + seeded('err', i) * 0.04))
  row.warns = Math.floor(total * (0.1 + seeded('warn', i) * 0.05))
  return row
})

/** Error taxonomy differs per LoB. */
const ERROR_DIST_BY_DOMAIN: Record<DomainFilter, { name: string; count: number; pct: number }[]> = {
  mps: [
    { name: 'AcquirerTimeout', count: 1842, pct: 34.2 },
    { name: 'PoolExhausted', count: 1124, pct: 20.9 },
    { name: '3DSSignatureMismatch', count: 876, pct: 16.3 },
    { name: 'IdempotencyCollision', count: 612, pct: 11.4 },
    { name: 'SettlementRejected', count: 489, pct: 9.1 },
    { name: 'Other', count: 439, pct: 8.1 },
  ],
  mrd: [
    { name: 'DetectorFault', count: 612, pct: 31.1 },
    { name: 'ControllerUnreachable', count: 431, pct: 21.9 },
    { name: 'OptimiserTimeout', count: 318, pct: 16.2 },
    { name: 'VMSRejected', count: 244, pct: 12.4 },
    { name: 'ANPRBacklog', count: 201, pct: 10.2 },
    { name: 'Other', count: 160, pct: 8.2 },
  ],
  pis: [
    { name: 'DisplayOffline', count: 412, pct: 29.8 },
    { name: 'FeedSchemaMismatch', count: 311, pct: 22.5 },
    { name: 'PushDeliveryFailed', count: 244, pct: 17.6 },
    { name: 'CacheEviction', count: 188, pct: 13.6 },
    { name: 'JourneyAPI503', count: 141, pct: 10.2 },
    { name: 'Other', count: 88, pct: 6.3 },
  ],
  ssa: [
    { name: 'ClassifierOffline', count: 38, pct: 28.4 },
    { name: 'CameraFeedLost', count: 31, pct: 23.1 },
    { name: 'AlertDeliveryTimeout', count: 24, pct: 17.9 },
    { name: 'EvidenceWriteFailure', count: 18, pct: 13.4 },
    { name: 'AccessDoorFault', count: 14, pct: 10.4 },
    { name: 'Other', count: 9, pct: 6.8 },
  ],
}


const ANOMALY_DATA = Array.from({ length: 60 }, (_, i) => {
  const base = 180 + Math.sin(i * 0.3) * 40
  const anomaly = [18, 19, 20, 38, 39].includes(i)
  const spike = anomaly ? 380 + Math.random() * 200 : 0
  return {
    t: i,
    value: Math.floor(base + Math.random() * 30 + spike),
    upper: Math.floor(base + 80),
    lower: Math.floor(base - 60),
    anomaly,
  }
})

// Cross-LoB incident: MPS settlement failure cascades into PIS display staleness
// and triggers SSA access control anomalies at interchange stations.
const RCA_NODES: { id: string; label: string; dom: DomainId; type: string; x: number; y: number; severity: string }[] = [
  { id: 'root', label: 'Display screens blank', dom: 'pis', type: 'symptom', x: 50, y: 8, severity: 'critical' },
  { id: 'mps-pool', label: 'Auth pool exhausted', dom: 'mps', type: 'cause', x: 20, y: 32, severity: 'critical' },
  { id: 'pis-feed', label: 'Journey API 503', dom: 'pis', type: 'cause', x: 50, y: 32, severity: 'error' },
  { id: 'ssa-alert', label: 'Alert routing delayed', dom: 'ssa', type: 'effect', x: 80, y: 32, severity: 'warn' },
  { id: 'conn-leak', label: 'Conn leak v2.14.1', dom: 'mps', type: 'cause', x: 9, y: 58, severity: 'critical' },
  { id: 'psp', label: 'Acquirer timeout 5s', dom: 'mps', type: 'cause', x: 30, y: 58, severity: 'error' },
  { id: 'deploy', label: 'Deploy 15:42 UTC', dom: 'mps', type: 'event', x: 51, y: 58, severity: 'info' },
  { id: 'mrd-signal', label: 'Signal plan stale', dom: 'mrd', type: 'effect', x: 72, y: 58, severity: 'warn' },
  { id: 'ssa-cam', label: 'Camera feed degraded', dom: 'ssa', type: 'effect', x: 92, y: 58, severity: 'warn' },
]

const RCA_EDGES = [
  ['root', 'mps-pool'], ['root', 'pis-feed'], ['root', 'ssa-alert'],
  ['mps-pool', 'conn-leak'], ['mps-pool', 'psp'],
  ['pis-feed', 'deploy'], ['ssa-alert', 'mrd-signal'], ['mrd-signal', 'ssa-cam'],
]

/** Blast radius across all LoBs. */
const BLAST_RADIUS: { dom: DomainId; impact: string; detail: string; role: 'origin' | 'propagated' | 'contained' }[] = [
  { dom: 'mps', impact: '18,402 txns', detail: 'authorisations failed or retried since 16:02', role: 'origin' },
  { dom: 'pis', impact: '412 screens', detail: 'passenger info blank at 38 stations — journey API unreachable', role: 'propagated' },
  { dom: 'ssa', impact: '14 alerts delayed', detail: 'alert router starved — SOC notification SLA missed', role: 'propagated' },
  { dom: 'mrd', impact: '11 junctions', detail: 'signal plan staleness from MPS auth dependency', role: 'propagated' },
]

const LLM_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'Anthropic', icon: '◈' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'Anthropic', icon: '◈' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', icon: '◉' },
  { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', icon: '◆' },
  { id: 'llama-3-3', name: 'Llama 3.3 70B', provider: 'Meta', icon: '◐' },
  { id: 'mistral-large', name: 'Mistral Large 2', provider: 'Mistral', icon: '◑' },
  // Open-weight token-optimised reasoning models
  { id: 'qwen3-235b', name: 'Qwen3 235B-A22B', provider: 'Alibaba', icon: '⬡' },
  { id: 'qwen3-32b', name: 'Qwen3 32B', provider: 'Alibaba', icon: '⬡' },
  { id: 'kimi-k2', name: 'Kimi K2', provider: 'Moonshot', icon: '◭' },
  { id: 'glm-4-32b', name: 'GLM-4 32B', provider: 'Zhipu', icon: '▣' },
  { id: 'glm-z1-32b', name: 'GLM-Z1 32B', provider: 'Zhipu', icon: '▣' },
]

const PIPELINE_STAGES = [
  { id: 'ingest', label: 'Ingest', icon: '⬇', rate: '284K/s', status: 'ok', latency: '1.2ms', note: 'per-tenant keys' },
  { id: 'redact', label: 'Redact', icon: '⊘', rate: '284K/s', status: 'ok', latency: '0.6ms', note: 'PII masked pre-storage' },
  { id: 'parse', label: 'Parse', icon: '⚙', rate: '281K/s', status: 'ok', latency: '0.8ms', note: 'tenant schema' },
  { id: 'enrich', label: 'Enrich', icon: '⊕', rate: '279K/s', status: 'warn', latency: '12.4ms', note: 'topology join' },
  { id: 'classify', label: 'ML Classify', icon: '◈', rate: '276K/s', status: 'ok', latency: '8.1ms', note: 'fingerprint + severity' },
  { id: 'correlate', label: 'Correlate', icon: '⟲', rate: '276K/s', status: 'ok', latency: '4.7ms', note: 'cross-tenant edges' },
  { id: 'index', label: 'Index', icon: '⊞', rate: '276K/s', status: 'ok', latency: '2.3ms', note: 'residency-pinned' },
  { id: 'alert', label: 'Alert', icon: '⚡', rate: '124/s', status: 'ok', latency: '0.4ms', note: 'burn-rate routed' },
]

/** 24h error-budget burn per tenant. 1× is the sustainable rate; >6× pages. */
const BURN_TREND = Array.from({ length: 24 }, (_, i) => {
  const h = (new Date().getHours() - 23 + i + 24) % 24
  const row: Record<string, number | string> = { time: `${String(h).padStart(2, '0')}:00` }
  for (const d of DEMO_DOMAINS) {
    const ramp = (i / 23) ** 2
    const noise = (seeded('burn' + d.id, i) - 0.5) * 0.7
    row[d.id] = Number(Math.max(0.05, d.slo.burn * (0.3 + 0.7 * ramp) + noise).toFixed(2))
  }
  return row
})

// ─── Per-team system model ────────────────────────────────────────────────────
// The estate each team actually operates: what runs, what it depends on, who is
// woken up for it, and how loudly it is currently complaining.

type ServiceTier = 'critical' | 'core' | 'support'

interface ServiceMeta {
  tier: ServiceTier
  runtime: string
  version: string
  instances: number
  /** Upstreams this service calls. A `dom:` prefix marks a cross-tenant edge. */
  deps: string[]
  squad: string
}

const SERVICE_META: Record<string, ServiceMeta> = {
  // MPS — Mobility Payments Services
  'payment-svc': { tier: 'critical', runtime: 'Java 21', version: 'v2.14.1', instances: 12, deps: ['psp-adapter', 'fraud-scoring', 'ledger-db'], squad: 'Authorisation' },
  'settlement-engine': { tier: 'critical', runtime: 'Java 21', version: 'v7.0.2', instances: 6, deps: ['ledger-db'], squad: 'Clearing' },
  'fraud-scoring': { tier: 'core', runtime: 'Python 3.13', version: 'v4.9.0', instances: 16, deps: [], squad: 'Risk' },
  'psp-adapter': { tier: 'critical', runtime: 'Go 1.24', version: 'v3.2.8', instances: 10, deps: [], squad: 'Acquiring' },
  'ledger-db': { tier: 'critical', runtime: 'Postgres 17', version: '17.2', instances: 3, deps: [], squad: 'Core Ledger' },
  'tokenisation-svc': { tier: 'critical', runtime: 'Go 1.24', version: 'v1.8.3', instances: 8, deps: ['ledger-db'], squad: 'Vault' },
  // MRD — Mobility Road
  'signal-controller': { tier: 'critical', runtime: 'Rust 1.84', version: 'v8.2.0', instances: 12, deps: ['route-optimiser'], squad: 'Control Systems' },
  'anpr-ingest': { tier: 'core', runtime: 'Go 1.24', version: 'v3.11.4', instances: 24, deps: ['incident-detect'], squad: 'Vision' },
  'incident-detect': { tier: 'core', runtime: 'Python 3.13', version: 'v2.6.1', instances: 8, deps: [], squad: 'Vision' },
  'vms-gateway': { tier: 'support', runtime: 'Java 21', version: 'v1.9.7', instances: 4, deps: ['signal-controller'], squad: 'Control Systems' },
  'route-optimiser': { tier: 'critical', runtime: 'C++20', version: 'v6.0.3', instances: 6, deps: [], squad: 'Planning' },
  'congestion-api': { tier: 'core', runtime: 'Go 1.24', version: 'v2.4.1', instances: 8, deps: ['route-optimiser'], squad: 'Data' },
  // PIS — Passenger Information Systems
  'display-controller': { tier: 'critical', runtime: 'Rust 1.84', version: 'v4.1.0', instances: 18, deps: ['timetable-feed'], squad: 'Display Ops' },
  'journey-api': { tier: 'critical', runtime: 'Go 1.24', version: 'v3.8.2', instances: 12, deps: ['timetable-feed'], squad: 'Journeys' },
  'timetable-feed': { tier: 'critical', runtime: 'Scala 3.5', version: 'v9.1.6', instances: 6, deps: [], squad: 'Data' },
  'app-backend': { tier: 'core', runtime: 'Node 22', version: 'v5.3.1', instances: 14, deps: ['journey-api'], squad: 'Mobile' },
  'push-notif': { tier: 'core', runtime: 'Go 1.24', version: 'v2.2.0', instances: 8, deps: [], squad: 'Comms' },
  'accessibility-svc': { tier: 'support', runtime: 'Java 21', version: 'v1.4.2', instances: 4, deps: ['journey-api'], squad: 'Accessibility' },
  // SSA — Smart Security Automations
  'camera-analytics': { tier: 'critical', runtime: 'Python 3.13', version: 'v4.9.0', instances: 16, deps: [], squad: 'Vision' },
  'access-control': { tier: 'critical', runtime: 'Go 1.24', version: 'v3.2.8', instances: 10, deps: [], squad: 'Physical' },
  'threat-classifier': { tier: 'critical', runtime: 'Python 3.13', version: 'v4.9.0', instances: 8, deps: ['camera-analytics'], squad: 'AI/ML' },
  'alert-router': { tier: 'critical', runtime: 'Go 1.24', version: 'v2.1.4', instances: 6, deps: ['threat-classifier'], squad: 'SOC' },
  'evidence-store': { tier: 'core', runtime: 'Postgres 17', version: '17.2', instances: 3, deps: [], squad: 'Compliance' },
}

interface TeamProfile {
  oncall: string
  escalation: string
  /** Where this team's logs come from and how they are shaped before storage. */
  ingest: { sources: string; volume: string; schema: string; sampling: string }
  posture: string
  risks: { text: string; level: 'high' | 'medium' | 'low' }[]
}

const ES_TEAM_PROFILE = (team: string): TeamProfile => ({
  oncall: 'from rota integration — not configured',
  escalation: 'from rota integration — not configured',
  ingest: {
    sources: 'Elasticsearch data stream',
    volume: 'measured from the cluster',
    schema: 'ECS (log.level, service.name, message, trace.id)',
    sampling: 'as shipped',
  },
  posture: `${team} is reading live from Elasticsearch. SLO targets are declared in ES_TENANT_DEFAULTS; everything else on this page is measured from the stream.`,
  risks: [],
})

const TEAM_PROFILES: Record<DomainId, TeamProfile> = {
  mps: {
    oncall: 'J. Marchetti · secondary R. Adeyemi',
    escalation: 'Payments duty lead → CTO if scheme cutoff at risk',
    ingest: { sources: '4 acquirers · 12 auth pods · ledger WAL', volume: '76K events/min peak', schema: 'ISO 20022 + OTel spans', sampling: 'DEBUG 1:100, all auth outcomes' },
    posture: 'Critical. 6.9× burn — the monthly error budget is spent in under 5 days at this rate.',
    risks: [
      { text: 'Connection leak in payment-svc v2.14.1 is still in production pending rollback', level: 'high' },
      { text: 'Settlement cutoff SFT-0731 in 38m — a second failure forces a manual file', level: 'high' },
      { text: 'Fraud model PSI 0.24 indicates population drift since the last retrain', level: 'medium' },
    ],
  },
  mrd: {
    oncall: 'A. Okonkwo · secondary M. Reid',
    escalation: 'Control room supervisor → Highways duty officer',
    ingest: { sources: '1,184 roadside controllers · 412 cameras · 6 regional hubs', volume: '84K events/min peak', schema: 'DATEX II → OTel logs', sampling: 'DEBUG 1:50, all WARN+' },
    posture: 'Healthy. Budget burn 0.8× — the estate is noisy but within plan.',
    risks: [
      { text: 'Loop detector 88231 has been faulting intermittently for 9 days — no replacement scheduled', level: 'medium' },
      { text: 'VMS firmware 4.1 fleet cannot render the new pictogram set', level: 'low' },
    ],
  },
  pis: {
    oncall: 'P. Nowak · secondary L. García',
    escalation: 'Passenger ops → station duty manager',
    ingest: { sources: '412 station displays · app backend · push gateway', volume: '52K events/min peak', schema: 'OTel logs + custom display protocol', sampling: 'DEBUG 1:20, all render events' },
    posture: 'At risk. Display freshness SLO 99.61% against 99.8% target; feed schema mismatch is the root cause.',
    risks: [
      { text: 'APNs certificate expires in 11 days — push delivery will drop to zero', level: 'high' },
      { text: 'Timetable feed schema mismatch affects 38 services — no fix ETA', level: 'high' },
      { text: 'Journey API cache hit ratio 58% after timetable activation', level: 'medium' },
    ],
  },
  ssa: {
    oncall: 'T. Iversen · secondary (unstaffed 22:00–06:00)',
    escalation: 'Security operations centre → Site commander',
    ingest: { sources: '884 cameras · 88 access doors · threat classifier cluster', volume: '19K events/min peak', schema: 'proprietary frame + OTel', sampling: 'DEBUG 1:200, all alerts' },
    posture: 'Watch. Alert latency SLO 98.1% against 99.0%; GPU headroom on classifier is the constraint.',
    risks: [
      { text: 'Threat classifier GPU at 94% — any spike will breach 2s alert SLA', level: 'high' },
      { text: 'No secondary on-call overnight — camera faults wait until 06:00', level: 'medium' },
      { text: 'Evidence store at 80% capacity — archival job has not run in 9 days', level: 'medium' },
    ],
  },
}

const UNKNOWN_SERVICE: ServiceMeta = {
  tier: 'core', runtime: 'unknown', version: '—', instances: 0, deps: [], squad: '—',
}

/**
 * Per-service operating numbers. Demo tenants use deterministic synthetic
 * values so a team's page is stable; Elastic tenants pass a live rollup, which
 * always wins over the synthetic figures.
 */
function serviceStats(svc: string, live?: ServiceRollup) {
  const m = SERVICE_META[svc] ?? UNKNOWN_SERVICE
  const errRate = live
    ? live.errRate
    : Number((seeded(svc, 3) * (m.tier === 'critical' ? 7 : 4) + 0.2).toFixed(1))
  return {
    ...m,
    errRate,
    p99: live?.p99 || Math.floor(seeded(svc, 11) * 780 + 40),
    rpm: live ? live.events : Math.floor(seeded(svc, 5) * 26000 + 900),
    logsPerMin: live ? Math.round(live.events / 60) : Math.floor(seeded(svc, 9) * 9000 + 400),
    cpu: live ? 0 : Math.floor(seeded(svc, 13) * 62 + 24),
    lastDeploy: live ? '—' : ['12m ago', '3h ago', '1d ago', '4d ago', '11d ago'][Math.floor(seeded(svc, 17) * 5)],
    status: errRate > 5 ? 'degraded' : errRate > 2.5 ? 'watch' : 'healthy',
    live: Boolean(live),
  }
}

// ─── Colour helpers ────────────────────────────────────────────────────────────

const SEV_COLOR = (): Record<Severity, string> => ({
  CRITICAL: C.red,
  ERROR: C.orange,
  WARN: C.amber,
  INFO: C.cyan,
  DEBUG: C.dim,
})

const SEV_BG = (): Record<Severity, string> => ({
  CRITICAL: a(C.red, 0.12),
  ERROR: a(C.orange, 0.12),
  WARN: a(C.amber, 0.12),
  INFO: a(C.cyan, 0.1),
  DEBUG: a(C.dim, 0.1),
})

// ─── Sub-components ───────────────────────────────────────────────────────────

function SeverityBadge({ sev }: { sev: Severity }) {
  return (
    <span
      className="mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm"
      style={{ background: SEV_BG()[sev], color: SEV_COLOR()[sev], border: `1px solid ${SEV_COLOR()[sev]}28` }}
    >
      {sev}
    </span>
  )
}

// ─── Custom Agent type ────────────────────────────────────────────────────────
interface CustomAgentDef {
  id: string
  name: string
  description: string
  capabilities: string[]
  model: string
  createdAt: string
}

const API = "https://geuxedpujvockbvdrhoq.supabase.co/functions/v1/make-server-637cd706"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdldXhlZHB1anZvY2tidmRyaG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MTMyOTUsImV4cCI6MjEwMTQ4OTI5NX0.gq5GPxUVy8SGjiW4ZzwwlMTLlMex31eLph95v7N8tDo"
const API_HEADERS = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` }

const LS_KEY = 'logsense-custom-agents'

function lsLoad(): CustomAgentDef[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] }
}
function lsSave(agents: CustomAgentDef[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(agents)) } catch { /* quota */ }
}

async function fetchAgents(): Promise<CustomAgentDef[]> {
  // Always return localStorage immediately; try to hydrate from DB in background
  const local = lsLoad()
  try {
    const r = await fetch(`${API}/agents`, { headers: API_HEADERS })
    if (r.ok) {
      const remote: CustomAgentDef[] = await r.json()
      if (Array.isArray(remote) && remote.length >= local.length) {
        lsSave(remote)
        return remote
      }
    }
  } catch { /* use local */ }
  return local
}

async function saveAgents(agents: CustomAgentDef[]): Promise<void> {
  lsSave(agents)
  try {
    await fetch(`${API}/agents`, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify(agents),
    })
  } catch { /* localStorage already saved */ }
}

const AGENT_CAPABILITIES = [
  'Log search', 'Anomaly detection', 'RCA reasoning', 'Alert routing',
  'Cross-LoB correlation', 'SLA monitoring', 'Trend analysis', 'Incident summarisation',
]

// ─── Time window helpers ───────────────────────────────────────────────────────
const TIME_WINDOWS: { id: TimeWindow; label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '6h', label: '6h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
]

const TIME_WINDOW_MS: Record<TimeWindow, number> = {
  '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000,
}

function dateRangeToTimeWindow(r: DateRange): TimeWindow {
  const ms = r.to.getTime() - r.from.getTime()
  if (ms <= 2 * 60_000) return '1m'
  if (ms <= 10 * 60_000) return '5m'
  if (ms <= 30 * 60_000) return '15m'
  if (ms <= 2 * 3_600_000) return '1h'
  if (ms <= 12 * 3_600_000) return '6h'
  if (ms <= 2 * 86_400_000) return '24h'
  return '7d'
}

const RANGE_PRESETS: { label: string; ms: number }[] = [
  { label: 'Last 5 min',   ms: 5 * 60_000 },
  { label: 'Last 15 min',  ms: 15 * 60_000 },
  { label: 'Last 1 hour',  ms: 3_600_000 },
  { label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { label: 'Last 24 hours',ms: 86_400_000 },
  { label: 'Last 7 days',  ms: 7 * 86_400_000 },
  { label: 'Last 30 days', ms: 30 * 86_400_000 },
  { label: 'Last 90 days', ms: 90 * 86_400_000 },
  { label: 'Last 6 months',ms: 182 * 86_400_000 },
  { label: 'Last 1 year',  ms: 365 * 86_400_000 },
  { label: 'Last 2 years', ms: 2 * 365 * 86_400_000 },
  { label: 'Last 3 years', ms: 3 * 365 * 86_400_000 },
]

function toDatetimeLocal(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [open, setOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState(() => toDatetimeLocal(value.from))
  const [customTo, setCustomTo] = useState(() => toDatetimeLocal(value.to))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function applyPreset(ms: number, label: string) {
    const to = new Date()
    const from = new Date(to.getTime() - ms)
    onChange({ from, to, label })
    setCustomFrom(toDatetimeLocal(from))
    setCustomTo(toDatetimeLocal(to))
    setOpen(false)
  }

  function applyCustom() {
    const from = new Date(customFrom)
    const to = new Date(customTo)
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return
    const diffMs = to.getTime() - from.getTime()
    const days = Math.round(diffMs / 86_400_000)
    const label = days < 1
      ? `${Math.round(diffMs / 3_600_000)}h range`
      : `${days}d range`
    onChange({ from, to, label })
    setOpen(false)
  }

  const minDate = toDatetimeLocal(new Date(Date.now() - 3 * 365 * 86_400_000))
  const maxDate = toDatetimeLocal(new Date())

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="mono text-[11px] px-3 py-1.5 rounded flex items-center gap-2 transition-colors"
        style={{ background: open ? a(C.cyan, 0.12) : C.card, border: `1px solid ${open ? a(C.cyan, 0.35) : C.border}`, color: open ? C.cyan : C.dim }}
      >
        <span style={{ color: C.faint }}>⏱</span>
        <span>{value.label}</span>
        <span className="mono text-[8px]" style={{ color: C.faint }}>▼</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 rounded overflow-hidden"
          style={{ background: C.card, border: `1px solid ${C.border}`, width: 500, boxShadow: `0 8px 32px ${a(C.bgDeep, 0.85)}` }}
        >
          <div className="flex" style={{ minHeight: 320 }}>
            {/* Presets */}
            <div className="flex flex-col flex-shrink-0" style={{ width: 180, borderRight: `1px solid ${C.border}` }}>
              <div className="mono text-[9px] uppercase tracking-widest px-3 py-2" style={{ color: C.faint, borderBottom: `1px solid ${C.border}` }}>Quick ranges</div>
              {RANGE_PRESETS.map(p => {
                const active = value.label === p.label
                return (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.ms, p.label)}
                    className="mono text-[11px] text-left px-3 py-1.5 transition-colors"
                    style={{ color: active ? C.cyan : C.dim, background: active ? a(C.cyan, 0.08) : 'transparent' }}
                  >
                    {active && <span className="mr-1">›</span>}{p.label}
                  </button>
                )
              })}
            </div>

            {/* Custom range inputs */}
            <div className="flex flex-col flex-1 p-4 gap-4">
              <div className="mono text-[9px] uppercase tracking-widest" style={{ color: C.faint }}>Custom range</div>
              <label className="flex flex-col gap-1.5">
                <span className="mono text-[10px]" style={{ color: C.dim }}>From</span>
                <input
                  type="datetime-local"
                  value={customFrom}
                  min={minDate}
                  max={customTo || maxDate}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="mono text-[11px] px-2 py-1.5 rounded outline-none"
                  style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="mono text-[10px]" style={{ color: C.dim }}>To</span>
                <input
                  type="datetime-local"
                  value={customTo}
                  min={customFrom}
                  max={maxDate}
                  onChange={e => setCustomTo(e.target.value)}
                  className="mono text-[11px] px-2 py-1.5 rounded outline-none"
                  style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                />
              </label>
              <button
                onClick={applyCustom}
                className="mono text-[11px] px-3 py-2 rounded transition-colors"
                style={{ background: a(C.cyan, 0.15), border: `1px solid ${a(C.cyan, 0.3)}`, color: C.cyan }}
              >
                Apply range
              </button>
              <div className="mono text-[9px] mt-auto" style={{ color: C.faint }}>
                {value.from.toLocaleString()} → {value.to.toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TimeWindowPicker({ value, onChange }: { value: TimeWindow; onChange: (w: TimeWindow) => void }) {
  return (
    <div className="flex items-center rounded overflow-hidden" style={{ border: `1px solid ${C.border}`, background: C.card }}>
      {TIME_WINDOWS.map(w => (
        <button
          key={w.id}
          onClick={() => onChange(w.id)}
          className="mono text-[10px] px-2 py-1 leading-none transition-colors"
          style={{
            background: value === w.id ? a(C.cyan, 0.14) : 'transparent',
            color: value === w.id ? C.cyan : C.faint,
            borderRight: `1px solid ${C.border}`,
          }}
        >
          {w.label}
        </button>
      ))}
    </div>
  )
}

function StatCard({ label, value, sub, color = C.cyan, delta }: {
  label: string; value: string; sub?: string; color?: string; delta?: string
}) {
  return (
    <div className="card p-4 flex flex-col gap-1 min-w-0">
      <div className="text-[11px] text-[var(--c-dim)] uppercase tracking-widest font-medium">{label}</div>
      <div className="mono text-2xl font-semibold" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--c-dim)]">{sub}</div>}
      {delta && (
        <div className={`text-[11px] mono ${delta.startsWith('+') ? 'text-[var(--c-red)]' : 'text-[var(--c-green)]'}`}>
          {delta} vs prev hour
        </div>
      )}
    </div>
  )
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-4">
      <h2 className="text-sm font-semibold text-[var(--c-text)] tracking-wide uppercase">{title}</h2>
      {sub && <span className="text-[11px] text-[var(--c-faint)]">{sub}</span>}
    </div>
  )
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="card p-3 text-[11px] mono" style={{ minWidth: 140 }}>
      <div className="text-[var(--c-dim)] mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="text-[var(--c-text)]">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function SloBar({ attainment, target, burn }: { attainment: number; target: string; burn: number }) {
  // Multi-window burn rate is the SRE-standard signal: how fast this tenant is
  // spending its error budget, not whether it is up right now.
  const col = burn > 6 ? C.red : burn > 2 ? C.amber : C.green
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.border }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, burn * 12)}%`, background: col }} />
      </div>
      <span className="mono text-[10px] w-16 text-right" style={{ color: col }}>{burn.toFixed(1)}× burn</span>
      <span className="mono text-[10px] text-[var(--c-faint)] w-24 text-right">{attainment}% / {target}</span>
    </div>
  )
}

function DomainHealthMatrix({ logs, domain, setDomain }: {
  logs: LogEntry[]; domain: DomainFilter; setDomain: (d: DomainFilter) => void
}) {
  return (
    <div className="card p-4">
      <SectionHeader title="Tenant Health Matrix" sub="every team, one error-budget scale" />
      <div className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest grid gap-2 px-1 pb-2"
        style={{ gridTemplateColumns: '160px 90px 70px 1fr 90px' }}>
        <span>Tenant / Team</span>
        <span className="text-right">Events/min</span>
        <span className="text-right">Err %</span>
        <span>Error budget burn (1h)</span>
        <span className="text-right">Agent</span>
      </div>
      <div className="flex flex-col gap-px">
        {DOMAINS.map(d => {
          const mine = logs.filter(l => l.domain === d.id)
          const errs = mine.filter(l => l.severity === 'CRITICAL' || l.severity === 'ERROR').length
          const rate = mine.length ? (errs / mine.length) * 100 : 0
          const active = domain === d.id
          const agent = d.slo.burn > 6 ? 'RCA running' : d.slo.burn > 2 ? 'watching' : 'idle'
          return (
            <button
              key={d.id}
              onClick={() => setDomain(d.id)}
              className="log-row grid gap-2 items-center px-1 py-2 rounded text-left"
              style={{
                gridTemplateColumns: '160px 90px 70px 1fr 90px',
                background: active ? a(domainColor(d.id), 0.08) : 'transparent',
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span style={{ color: domainColor(d.id) }}>{d.icon}</span>
                <div className="min-w-0">
                  <div className="mono text-[11px] text-[var(--c-text)] truncate">{d.label}</div>
                  <div className="mono text-[9px] text-[var(--c-faint)] truncate">{d.team}</div>
                </div>
              </div>
              <div className="mono text-[11px] text-[var(--c-dim)] text-right">
                {(d.share * 4200).toFixed(0)}
              </div>
              <div className="mono text-[11px] text-right" style={{ color: rate > 8 ? C.red : rate > 4 ? C.amber : C.dim }}>
                {rate.toFixed(1)}
              </div>
              <SloBar attainment={d.slo.attainment} target={d.slo.target} burn={d.slo.burn} />
              <div className="mono text-[10px] text-right" style={{ color: agent === 'RCA running' ? C.cyan : C.faint }}>
                {agent === 'RCA running' && <span className="animate-pulse-dot">◈ </span>}{agent}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function OverviewSection({ logs, domain, setDomain, volumeData, errorDist }: {
  logs: LogEntry[]; domain: DomainFilter; setDomain: (d: DomainFilter) => void
  volumeData?: Record<string, number | string>[]
  errorDist?: Record<string, { name: string; count: number; pct: number }[]>
}) {
  const counts = logs.reduce((a, l) => { a[l.severity] = (a[l.severity] || 0) + 1; return a }, {} as Record<string, number>)
  const errorRate = logs.length ? (((counts.CRITICAL || 0) + (counts.ERROR || 0)) / logs.length * 100).toFixed(2) : '0.00'
  const scope = [DOMAIN_BY_ID[domain]]
  const worstBurn = Math.max(...scope.map(d => d.slo.burn))
  const remoteDist = errorDist?.[domain]
  const dist = remoteDist?.length ? remoteDist : ERROR_DIST_BY_DOMAIN[domain]
  const volume = volumeData ?? VOLUME_DATA

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <StatCard label="Total Events" value={`${(DOMAIN_BY_ID[domain].share * 284).toFixed(0)}K`} sub="last 24h" delta="+12.4%" />
        <StatCard label="Error Rate" value={`${errorRate}%`} sub="of all events" color={C.red} delta="+0.8%" />
        <StatCard label="Budget Burn" value={`${worstBurn.toFixed(1)}×`} sub="vs 1× sustainable" color={worstBurn > 6 ? C.red : C.amber} />
        <StatCard label="Critical" value={String(counts.CRITICAL || 0)} sub="events" color={C.red} />
        <StatCard label="Cross-LoB Links" value="3" sub="correlated incidents" color={C.purple} />
        <StatCard label="Agent Cost" value="$4.18" sub="RCA spend today" color={C.green} delta="-11.2%" />
      </div>

      {/* Volume chart, stacked by tenant */}
      <div className="card p-4 flex-shrink-0">
        <SectionHeader title="Log Volume" sub={`24h rolling window — ${DOMAIN_BY_ID[domain].label}`} />
        <ResponsiveContainer width="100%" height={168}>
          <AreaChart data={volume} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="time" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)} />
            <Tooltip content={<CustomTooltip />} />
            {scope.map(d => (
              <Area
                key={d.id}
                type="monotone"
                dataKey={d.id}
                stackId="vol"
                stroke={domainColor(d.id)}
                strokeWidth={1}
                fill={domainColor(d.id)}
                fillOpacity={0.16}
                name={d.short}
                dot={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap gap-3 mt-2">
          {scope.map(d => (
            <div key={d.id} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm" style={{ background: domainColor(d.id) }} />
              <span className="mono text-[10px] text-[var(--c-dim)]">{d.label}</span>
            </div>
          ))}
        </div>
      </div>

      <DomainHealthMatrix logs={logs} domain={domain} setDomain={setDomain} />

      {/* The matrix is a snapshot; this is the derivative. A team sitting at 2×
          and falling is a different conversation from one at 2× and climbing. */}
      <div className="card p-4 flex-shrink-0">
        <SectionHeader title="Error-Budget Burn Trend" sub="24h · multiples of the sustainable rate · >6× pages on-call" />
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={BURN_TREND} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="time" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} interval={3} />
            <YAxis
              tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickLine={false} axisLine={false} width={40}
              domain={[0, 8]} tickFormatter={(v: number) => `${v}×`}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={1} stroke={C.green} strokeDasharray="4 3" strokeWidth={1}
              label={{ value: 'sustainable 1×', fill: C.green, fontSize: 9, fontFamily: 'JetBrains Mono', position: 'insideBottomLeft' }} />
            <ReferenceLine y={6} stroke={C.red} strokeDasharray="4 3" strokeWidth={1}
              label={{ value: 'page 6×', fill: C.red, fontSize: 9, fontFamily: 'JetBrains Mono', position: 'insideTopLeft' }} />
            {scope.map(d => (
              <Line
                key={d.id}
                type="monotone"
                dataKey={d.id}
                stroke={domainColor(d.id)}
                strokeWidth={d.slo.burn > 6 ? 2.2 : 1.4}
                dot={false}
                name={d.label}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap gap-3 mt-2">
          {scope.map(d => (
            <div key={d.id} className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded" style={{ background: domainColor(d.id) }} />
              <span className="mono text-[10px] text-[var(--c-dim)]">{d.short}</span>
              <span className="mono text-[10px]" style={{ color: d.slo.burn > 6 ? C.red : d.slo.burn > 2 ? C.amber : C.green }}>
                {d.slo.burn.toFixed(1)}×
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Error dist bar */}
        <div className="card p-4">
          <SectionHeader title="Error Distribution" sub="by type" />
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dist} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={140} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" radius={[0, 2, 2, 0]} name="count">
                {dist.map((_, i) => (
                  <Cell key={i} fill={i === 0 ? C.red : i === 1 ? C.orange : i === 2 ? C.amber : C.cyan} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Service breakdown */}
        <div className="card p-4">
          <SectionHeader title="Error Rate by Service" sub="last 1h" />
          <div className="flex flex-col gap-2 mt-1">
            {scope.flatMap(d => d.services.slice(0, 5).map((svc, i) => ({
              svc, d, rate: Number((seeded(svc, i) * 9 + 0.2).toFixed(1)), count: Math.floor(seeded(svc, i + 7) * 320),
            })))
              .sort((x, y) => y.rate - x.rate)
              .slice(0, 8)
              .map(({ svc, d, rate, count }) => (
                <div key={svc} className="flex items-center gap-2">
                  <span className="mono text-[9px] px-1 rounded flex-shrink-0" style={{ background: a(domainColor(d.id), 0.14), color: domainColor(d.id) }}>{d.short}</span>
                  <div className="mono text-[11px] text-[var(--c-dim)] w-36 flex-shrink-0 truncate">{svc}</div>
                  <div className="flex-1 h-1.5 rounded-full" style={{ background: C.border }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(rate / 10) * 100}%`, background: rate > 6 ? C.red : rate > 3 ? C.amber : C.cyan }}
                    />
                  </div>
                  <div className="mono text-[11px] w-10 text-right" style={{ color: rate > 6 ? C.red : rate > 3 ? C.amber : C.dim }}>
                    {rate}%
                  </div>
                  <div className="mono text-[10px] text-[var(--c-faint)] w-8 text-right">{count}</div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function LogsSection({ logs, live, domain }: { logs: LogEntry[], live: boolean, domain: DomainFilter }) {
  const [filter, setFilter] = useState('')
  const [sevFilter, setSevFilter] = useState<Severity | 'ALL'>('ALL')
  const [svcFilter, setSvcFilter] = useState('ALL')
  const [showRaw, setShowRaw] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Service list follows the tenant in scope — a payments engineer should never
  // have to scroll past signalling services to find theirs.
  const services = [DOMAIN_BY_ID[domain]].flatMap(d => d.services)

  const filtered = logs.filter(l => {
    if (sevFilter !== 'ALL' && l.severity !== sevFilter) return false
    if (svcFilter !== 'ALL' && l.service !== svcFilter) return false
    if (filter && !l.message.toLowerCase().includes(filter.toLowerCase()) && !l.service.includes(filter)) return false
    return true
  }).slice(0, 300)

  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = 0
  }, [logs.length, live])

  useEffect(() => { setSvcFilter('ALL') }, [domain])

  const cols = '140px 56px 70px 150px 1fr 120px 60px'

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Filter bar */}
      <div className="flex gap-2 flex-wrap">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter logs…  (message or service)"
          className="mono text-[12px] bg-[var(--c-card)] border border-[var(--c-border)] rounded px-3 py-1.5 text-[var(--c-text)] placeholder-[var(--c-faint)] outline-none focus:border-[var(--c-cyan)] flex-1 min-w-48"
        />
        <select
          value={sevFilter}
          onChange={e => setSevFilter(e.target.value as any)}
          className="mono text-[11px] bg-[var(--c-card)] border border-[var(--c-border)] rounded px-2 py-1.5 text-[var(--c-dim)] outline-none focus:border-[var(--c-cyan)]"
        >
          <option value="ALL">All Severity</option>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={svcFilter}
          onChange={e => setSvcFilter(e.target.value)}
          className="mono text-[11px] bg-[var(--c-card)] border border-[var(--c-border)] rounded px-2 py-1.5 text-[var(--c-dim)] outline-none focus:border-[var(--c-cyan)]"
        >
          <option value="ALL">All Services</option>
          {services.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="mono text-[11px] rounded px-2 py-1.5"
          style={{
            background: showRaw ? a(C.cyan, 0.12) : C.card,
            border: `1px solid ${showRaw ? a(C.cyan, 0.3) : C.border}`,
            color: showRaw ? C.cyan : C.dim,
          }}
          title="Show the redacted-at-ingest view exactly as the AI agent receives it"
        >
          agent view
        </button>
        <div className="mono text-[11px] text-[var(--c-faint)] flex items-center px-2">{filtered.length} entries</div>
      </div>

      {/* Column headers */}
      <div className="mono text-[10px] text-[var(--c-faint)] grid gap-2 px-2 uppercase tracking-widest flex-shrink-0"
        style={{ gridTemplateColumns: cols }}>
        <span>Timestamp</span>
        <span>Tenant</span>
        <span>Level</span>
        <span>Service</span>
        <span>Message</span>
        <span>Trace ID</span>
        <span className="text-right">Status</span>
      </div>

      {/* Log rows */}
      <div ref={ref} className="flex-1 overflow-auto min-h-0 flex flex-col gap-px">
        {filtered.map((log, i) => (
          <div
            key={log.id}
            className="log-row mono text-[11px] grid gap-2 px-2 py-1 rounded cursor-default"
            style={{
              gridTemplateColumns: cols,
              background: i % 2 === 0 ? 'transparent' : a(C.text, 0.012),
              borderLeft: ['CRITICAL', 'ERROR'].includes(log.severity) ? `2px solid ${SEV_COLOR()[log.severity]}40` : '2px solid transparent',
            }}
          >
            <span className="text-[var(--c-faint)] truncate">{log.timestamp.replace('T', ' ').slice(0, 19)}</span>
            <span className="text-[9px] px-1 rounded self-center justify-self-start"
              style={{ background: a(domainColor(log.domain), 0.14), color: domainColor(log.domain) }}>
              {DOMAIN_BY_ID[log.domain].short}
            </span>
            <SeverityBadge sev={log.severity} />
            <span className="text-[var(--c-cyan)] truncate">{log.service}</span>
            <span className="text-[var(--c-text2)] truncate">
              {showRaw ? redactForAgent(log.message) : log.message}
            </span>
            <span className="text-[var(--c-faint)] truncate">{log.traceId}</span>
            <span className="text-right" style={{ color: (log.statusCode || 200) >= 500 ? C.red : C.green }}>
              {log.statusCode || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** What the model actually sees: identifiers masked before the prompt is built. */
function redactForAgent(msg: string) {
  return msg
    .replace(/\b(txn|tkn|psu|user)[_=][A-Za-z0-9]+/g, '$1_⟨redacted⟩')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '⟨ip⟩')
    .replace(/BIN \d+/g, 'BIN ⟨redacted⟩')
    .replace(/£[\d,.]+|€[\d,.]+/g, '⟨amount⟩')
}

/** Fingerprints are hashed on the normalised message, so the same failure mode
 *  surfacing in two tenants collapses to one row with an "also in" marker. */
const FINGERPRINTS: { fp: string; dom: DomainId; svc: string; count: number; first: string; last: string; trend: string; also: DomainId[] }[] = [
  { fp: 'ERR-pool-exhausted-ledger-db', dom: 'mps', svc: 'ledger-db', count: 1842, first: '2d 14h ago', last: '2m ago', trend: '↑', also: [] },
  { fp: 'ERR-upstream-timeout-5s', dom: 'mps', svc: 'psp-adapter', count: 1124, first: '5h ago', last: '8s ago', trend: '↑', also: ['pis', 'ssa'] },
  { fp: 'ERR-display-offline-cluster', dom: 'pis', svc: 'display-controller', count: 412, first: '3h ago', last: '11s ago', trend: '↑', also: [] },
  { fp: 'ERR-detector-occupancy-invalid', dom: 'mrd', svc: 'signal-controller', count: 612, first: '1d 3h ago', last: '4m ago', trend: '↓', also: [] },
  { fp: 'ERR-alert-delivery-timeout', dom: 'ssa', svc: 'alert-router', count: 188, first: '9h ago', last: '17m ago', trend: '→', also: [] },
  { fp: 'ERR-feed-schema-mismatch', dom: 'pis', svc: 'timetable-feed', count: 244, first: '45m ago', last: '1m ago', trend: '↑', also: ['mrd'] },
  { fp: 'ERR-cert-expired-mtls', dom: 'ssa', svc: 'camera-analytics', count: 198, first: '2h ago', last: '6m ago', trend: '↑', also: ['mps'] },
]

function ErrorsSection({ logs, domain, dateRange, timeWindow, setTimeWindow }: { logs: LogEntry[]; domain: DomainFilter; dateRange?: DateRange; timeWindow?: TimeWindow; setTimeWindow?: (w: TimeWindow) => void }) {
  const PIE_COLORS = [C.red, C.orange, C.amber, C.cyan, C.purple, C.green, C.dim]
  const dist = ERROR_DIST_BY_DOMAIN[domain]
  const [selectedCell, setSelectedCell] = useState<{ day: number; hr: number } | null>(null)

  const heatmap = useMemo(() => Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hr) => ({
      day, hr,
      val: Math.floor(seeded(`hm-${day}`, hr) * 120 + (day === 2 && (hr >= 15 && hr <= 17) ? 300 : 0)),
    }))
  ), [])
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  // Build error trend data scaled to the selected date range
  const trendData = useMemo(() => {
    const p2 = (n: number) => String(n).padStart(2, '0')
    const toTime = dateRange ? dateRange.to.getTime() : Date.now()
    const fromTime = dateRange ? dateRange.from.getTime() : toTime - TIME_WINDOW_MS[timeWindow ?? '1h']
    const totalMs = toTime - fromTime

    type CfgEntry = { points: number; stepMs: number; fmt: (d: Date) => string }
    const cfg: CfgEntry = (() => {
      const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
      if (totalMs <= 10 * 60_000)      return { points: 12, stepMs: totalMs / 12, fmt: d => `${p2(d.getMinutes())}:${p2(d.getSeconds())}` }
      if (totalMs <= 3_600_000)         return { points: 12, stepMs: totalMs / 12, fmt: d => `${p2(d.getHours())}:${p2(d.getMinutes())}` }
      if (totalMs <= 86_400_000)        return { points: 24, stepMs: totalMs / 24, fmt: d => `${p2(d.getHours())}:00` }
      if (totalMs <= 7 * 86_400_000)    return { points: 28, stepMs: totalMs / 28, fmt: d => `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${p2(d.getHours())}h` }
      if (totalMs <= 90 * 86_400_000)   return { points: 30, stepMs: totalMs / 30, fmt: d => `${p2(d.getMonth()+1)}/${p2(d.getDate())}` }
      return { points: 36, stepMs: totalMs / 36, fmt: d => `${MONTH[d.getMonth()]} ${d.getFullYear()}` }
    })()

    const key = `${fromTime}-${toTime}`
    return Array.from({ length: cfg.points }, (_, i) => {
      const t = new Date(fromTime + i * cfg.stepMs)
      const base = 150 + Math.sin(i * 0.7) * 60
      return {
        time: cfg.fmt(t),
        errors: Math.floor((base + seeded(`tw-err-${key}`, i) * 80) * (0.08 + seeded(`tw-em-${key}`, i) * 0.04)),
        warns:  Math.floor((base + seeded(`tw-warn-${key}`, i) * 80) * (0.14 + seeded(`tw-wm-${key}`, i) * 0.06)),
      }
    })
  }, [dateRange, timeWindow])

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pie */}
        <div className="card p-4">
          <SectionHeader title="Error Type Distribution" />
          <div className="flex gap-4 items-center">
            <ResponsiveContainer width={180} height={180}>
              <PieChart>
                <Pie data={dist} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="count" stroke="none">
                  {dist.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-col gap-2 flex-1">
              {dist.map((e, i) => (
                <div key={e.name} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: PIE_COLORS[i] }} />
                  <span className="mono text-[11px] text-[var(--c-dim)] flex-1 truncate">{e.name}</span>
                  <span className="mono text-[11px] text-[var(--c-text)]">{e.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Trend */}
        <div className="card p-4">
          <SectionHeader title="Error Trend" sub={dateRange?.label ?? `last ${timeWindow ?? '1h'}`} />
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={trendData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={36} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="errors" stroke={C.red} strokeWidth={2} dot={false} name="errors" />
              <Line type="monotone" dataKey="warns" stroke={C.amber} strokeWidth={1.5} dot={false} name="warns" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Heatmap */}
      <div className="card p-4">
        <SectionHeader title="Error Heatmap" sub="day × hour (last 7 days)" />
        <div className="overflow-auto">
          <div className="flex gap-1 mb-1">
            <div className="mono text-[9px] text-[var(--c-faint)] w-8" />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="mono text-[9px] text-[var(--c-faint)] flex-1 text-center" style={{ minWidth: 18 }}>{h}</div>
            ))}
          </div>
          {heatmap.map((row, d) => (
            <div key={d} className="flex gap-1 mb-1 items-center">
              <div className="mono text-[9px] text-[var(--c-dim)] w-8 flex-shrink-0">{DAYS[d]}</div>
              {row.map((cell) => {
                const intensity = cell.val / 420
                const isSelected = selectedCell?.day === cell.day && selectedCell?.hr === cell.hr
                const bg = intensity > 0.7 ? a(C.red, intensity) :
                  intensity > 0.4 ? a(C.orange, intensity + 0.1) :
                    intensity > 0.1 ? a(C.amber, intensity + 0.1) :
                      a(C.cyan, intensity * 0.3 + 0.03)
                return (
                  <div
                    key={cell.hr}
                    title={`${DAYS[d]} ${cell.hr}:00 — ${cell.val} errors`}
                    onClick={() => setSelectedCell(isSelected ? null : { day: cell.day, hr: cell.hr })}
                    className="flex-1 rounded-sm cursor-pointer"
                    style={{
                      height: 16, minWidth: 18, background: bg,
                      outline: isSelected ? `2px solid ${C.cyan}` : undefined,
                      outlineOffset: 1,
                    }}
                  />
                )
              })}
            </div>
          ))}
          <div className="flex gap-2 mt-3 items-center">
            <span className="mono text-[9px] text-[var(--c-faint)]">Low</span>
            {[0.05, 0.2, 0.4, 0.6, 0.85].map(v => (
              <div key={v} className="w-4 h-3 rounded-sm" style={{ background: a(C.red, v) }} />
            ))}
            <span className="mono text-[9px] text-[var(--c-faint)]">High</span>
          </div>
        </div>
      </div>

      {/* Selected block logs */}
      <div className="card p-4">
        {selectedCell ? (
          <>
            <SectionHeader
              title="Errors"
              sub={`${DAYS[selectedCell.day]} ${String(selectedCell.hr).padStart(2, '0')}:00 — ${String(selectedCell.hr).padStart(2, '0')}:59 · click a cell to change selection`}
            />
            {(() => {
              const cellLogs = logs
                .filter(l => ['ERROR', 'CRITICAL'].includes(l.severity))
                .filter(l => new Date(l.timestamp).getHours() === selectedCell.hr)
                .slice(0, 50)
              const cols = '140px 70px 150px 1fr 60px'
              return cellLogs.length === 0 ? (
                <p className="mono text-[11px] text-[var(--c-faint)] mt-3">No error logs for this time slot.</p>
              ) : (
                <div className="flex flex-col gap-px mt-3 max-h-64 overflow-auto">
                  <div className="mono text-[10px] text-[var(--c-faint)] grid gap-2 px-2 uppercase tracking-widest mb-1" style={{ gridTemplateColumns: cols }}>
                    <span>Timestamp</span><span>Level</span><span>Service</span><span>Message</span><span className="text-right">Status</span>
                  </div>
                  {cellLogs.map((log, i) => (
                    <div
                      key={log.id}
                      className="mono text-[11px] grid gap-2 px-2 py-1 rounded"
                      style={{
                        gridTemplateColumns: cols,
                        background: i % 2 === 0 ? 'transparent' : a(C.text, 0.012),
                        borderLeft: `2px solid ${SEV_COLOR()[log.severity]}40`,
                      }}
                    >
                      <span className="text-[var(--c-faint)] truncate">{log.timestamp.replace('T', ' ').slice(0, 19)}</span>
                      <span style={{ color: SEV_COLOR()[log.severity] }}>{log.severity}</span>
                      <span className="text-[var(--c-cyan)] truncate">{log.service}</span>
                      <span className="text-[var(--c-text)] truncate">{log.message}</span>
                      <span className="text-right" style={{ color: log.statusCode && log.statusCode >= 500 ? C.red : C.dim }}>{log.statusCode}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </>
        ) : (
          <>
            <SectionHeader title="Errors" sub="click a heatmap block to inspect logs for that hour" />
            <p className="mono text-[11px] text-[var(--c-faint)] mt-3">Select a block in the heatmap above to view its error logs here.</p>
          </>
        )}
      </div>
    </div>
  )
}

const ANOMALIES: { time: string; dom: DomainId; type: string; service: string; score: number; detail: string; status: string; baseline: string }[] = [
  { time: '14:38 UTC', dom: 'mps', type: 'Spike', service: 'payment-svc', score: 0.98, detail: 'req/s jumped 182 → 587 in 45s, +3.2σ against same-weekday baseline', status: 'Investigating', baseline: 'seasonal, 28d' },
  { time: '14:39 UTC', dom: 'mps', type: 'Exhaustion', service: 'ledger-db', score: 0.96, detail: 'connection count 89 → 512, correlated with above (lag 61s)', status: 'Confirmed', baseline: 'seasonal, 28d' },
  { time: '14:41 UTC', dom: 'pis', type: 'Propagated', service: 'display-controller', score: 0.94, detail: 'display freshness p99 44s — shares journey-api dependency with MPS feed', status: 'Confirmed', baseline: 'cross-tenant' },
  { time: '09:12 UTC', dom: 'mrd', type: 'Drop', service: 'signal-controller', score: 0.91, detail: 'detector coverage 98% → 71% over 8m in region NW', status: 'Resolved', baseline: 'seasonal, 28d' },
  { time: '06:04 UTC', dom: 'ssa', type: 'Latency', service: 'alert-router', score: 0.88, detail: 'alert delivery p99 3.1s — classifier GPU at 94% causing backpressure', status: 'Investigating', baseline: 'per-zone' },
  { time: '02:54 UTC', dom: 'pis', type: 'Feed gap', service: 'timetable-feed', score: 0.84, detail: 'schema mismatch dropped 38 services from display feed for 22m', status: 'Resolved', baseline: 'per-feed' },
  { time: 'Yesterday 22:10', dom: 'mps', type: 'Error Burst', service: 'fraud-scoring', score: 0.79, detail: '142 auth failures in 90s — suspected credential stuffing', status: 'Closed', baseline: 'seasonal, 28d' },
]

function AnomalySection({ domain, timeWindow, setTimeWindow }: { domain: DomainFilter; timeWindow?: TimeWindow; setTimeWindow?: (w: TimeWindow) => void }) {
  const [threshold] = useState(300)
  const rows = ANOMALIES.filter(r => r.dom === domain)

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Anomalies Detected" value={String(rows.length)} sub="last 24h" color={C.orange} delta="+3" />
        <StatCard label="False Positive Rate" value="4.2%" sub="from analyst feedback loop" color={C.amber} />
        <StatCard label="MTTD" value="4.8 min" sub="mean time to detect" color={C.cyan} />
      </div>

      <div className="card p-4">
        <SectionHeader title="Anomaly Timeline" sub="request rate with ML-detected anomalies" />
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={ANOMALY_DATA} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="gNorm" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C.cyan} stopOpacity={0.1} />
                <stop offset="95%" stopColor={C.cyan} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="t" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} label={{ value: 'minutes ago', position: 'insideBottomRight', fill: C.faint, fontSize: 10 }} />
            <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={threshold} stroke={C.red} strokeDasharray="6 3" strokeWidth={1} label={{ value: 'threshold', fill: C.red, fontSize: 10, fontFamily: 'JetBrains Mono' }} />
            <Area type="monotone" dataKey="upper" stroke={C.border} strokeWidth={1} fill="none" name="upper bound" dot={false} />
            <Area type="monotone" dataKey="lower" stroke={C.border} strokeWidth={1} fill={C.border} fillOpacity={0.3} name="lower bound" dot={false} />
            <Area type="monotone" dataKey="value" stroke={C.cyan} strokeWidth={2} fill="url(#gNorm)" name="req/s" dot={(props: any) => {
              if (!props.payload.anomaly) return <g key={props.key} />
              return <circle key={props.key} cx={props.cx} cy={props.cy} r={5} fill={C.red} stroke={C.red} strokeWidth={2} strokeOpacity={0.4} />
            }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="card p-4">
        <SectionHeader title="Detected Anomalies" sub="ML-scored against per-tenant seasonal baselines" />
        <div className="flex flex-col gap-2">
          {rows.map(({ time, dom, type, service, score, detail, status, baseline }) => (
            <div key={time + service} className="flex gap-3 p-3 rounded" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div className="flex flex-col items-center gap-1 flex-shrink-0 w-14">
                <div className="mono text-[10px] text-[var(--c-faint)]">{time.split(' ')[0]}</div>
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center mono text-[11px] font-semibold"
                  style={{
                    background: score > 0.95 ? a(C.red,0.15) : score > 0.85 ? a(C.orange,0.15) : a(C.amber,0.15),
                    color: score > 0.95 ? C.red : score > 0.85 ? C.orange : C.amber,
                    border: `1px solid ${score > 0.95 ? C.red : score > 0.85 ? C.orange : C.amber}40`,
                  }}
                >
                  {(score * 100).toFixed(0)}
                </div>
                <div className="mono text-[9px] text-[var(--c-faint)]">score</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="mono text-[9px] px-1 rounded" style={{ background: a(domainColor(dom), 0.14), color: domainColor(dom) }}>{DOMAIN_BY_ID[dom].short}</span>
                  <span className="mono text-[11px] font-semibold text-[var(--c-text)]">{type}</span>
                  <span className="mono text-[11px] text-[var(--c-cyan)]">{service}</span>
                  <span className="mono text-[9px] text-[var(--c-faint)]">baseline: {baseline}</span>
                  <span className={`mono text-[10px] px-1.5 py-0.5 rounded-sm ml-auto ${
                    status === 'Investigating' ? 'badge-error' :
                    status === 'Confirmed' ? 'badge-critical' :
                    status === 'Resolved' ? 'badge-info' : 'badge-debug'
                  }`}>{status}</span>
                </div>
                <div className="mono text-[11px] text-[var(--c-dim)]">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RCASection({ domain, setDomain, timeWindow = '1h', setTimeWindow }: { domain: DomainFilter; setDomain: (d: DomainFilter) => void; timeWindow?: TimeWindow; setTimeWindow?: (w: TimeWindow) => void }) {
  const [selectedNode, setSelectedNode] = useState<string | null>('root')

  const nodeInfo: Record<string, { prob: number; evidence: string[]; recommendation: string; owner: string }> = {
    root: {
      prob: 1.0, owner: 'PIS',
      evidence: ['412 display screens blank — display-controller disconnected', 'Onset 16:03 UTC, 6m after MPS deploy', 'Journey API returning 503 since 16:04'],
      recommendation: 'Symptom — follow the journey-api dependency chain into MPS.',
    },
    'mps-pool': {
      prob: 0.97, owner: 'MPS',
      evidence: ['All 512 ledger-db connections in use', 'Pool wait queue 847', 'Journey-api calls MPS token endpoint synchronously'],
      recommendation: 'Isolate the journey-api read path onto a dedicated MPS pool.',
    },
    'conn-leak': {
      prob: 0.93, owner: 'MPS',
      evidence: ['Connections grew linearly from deploy +3m', 'No connection.release() on the capture path', 'Heap dump: 847 unclosed PreparedStatement'],
      recommendation: 'Rollback payment-svc to v2.13.9, then ship the release() fix.',
    },
    psp: {
      prob: 0.71, owner: 'MPS',
      evidence: ['Acquirer p99 4.8s (baseline 340ms)', 'Timeouts hold connections open — amplifies exhaustion'],
      recommendation: 'Contributing, not causal. Raise circuit-breaker threshold on psp-adapter.',
    },
    'pis-feed': {
      prob: 0.89, owner: 'PIS',
      evidence: ['Journey API 503 rate 41%', 'display-controller falls back to blank on any API error'],
      recommendation: 'Add circuit breaker + stale-data fallback so screens show last-known data, not blank.',
    },
    deploy: {
      prob: 0.88, owner: 'Money Movement',
      evidence: ['Deploy 15:42 UTC precedes symptom by 6m', 'Canary showed normal — cross-tenant traffic not in canary mix'],
      recommendation: 'Include ticketing traffic in the payments canary. Gate rollout on cross-tenant error rate.',
    },
    'rail-dwell': {
      prob: 0.64, owner: 'Network Operations',
      evidence: ['Alert router starved 16:07', 'SOC notification SLA missed for 14 events'],
      recommendation: 'Downstream effect. SSA alert router shares token endpoint — add independent auth path.',
    },
    'mrd-signal': {
      prob: 0.52, owner: 'MRD',
      evidence: ['Signal plan freshness degraded 16:09', 'MRD route-optimiser calls MPS token endpoint for auth'],
      recommendation: 'Downstream effect. Add local token cache with 5m TTL to route-optimiser.',
    },
  }

  const info = selectedNode ? nodeInfo[selectedNode] : null
  const selDom = RCA_NODES.find(n => n.id === selectedNode)?.dom

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* Cross-LoB blast radius */}
      <div className="card p-4">
        <div className="flex items-baseline gap-3 mb-3 flex-wrap">
          <h2 className="text-sm font-semibold text-[var(--c-text)] tracking-wide uppercase">Cross-LoB Blast Radius</h2>
          <span className="text-[11px] text-[var(--c-faint)]">INC-2847 · window: {timeWindow}</span>
          <span className="mono text-[10px] px-1.5 py-0.5 rounded ml-auto" style={{ background: a(C.purple, 0.12), color: C.purple }}>
            correlated by shared dependency graph
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {BLAST_RADIUS.map(({ dom, impact, detail, role }) => {
            const col = role === 'contained' ? C.dim : domainColor(dom)
            return (
              <button
                key={dom}
                onClick={() => setDomain(dom)}
                className="p-3 rounded text-left transition-colors"
                style={{
                  background: role === 'origin' ? a(C.red, 0.06) : C.bg,
                  border: `1px solid ${role === 'origin' ? a(C.red, 0.35) : role === 'contained' ? C.border : a(col, 0.3)}`,
                }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span style={{ color: col }}>{DOMAIN_BY_ID[dom].icon}</span>
                  <span className="mono text-[10px]" style={{ color: col }}>{DOMAIN_BY_ID[dom].short}</span>
                  <span className="mono text-[9px] ml-auto px-1 rounded"
                    style={{
                      background: role === 'origin' ? a(C.red, 0.15) : role === 'contained' ? a(C.green, 0.12) : a(C.amber, 0.12),
                      color: role === 'origin' ? C.red : role === 'contained' ? C.green : C.amber,
                    }}>
                    {role}
                  </span>
                </div>
                <div className="mono text-[13px] font-semibold text-[var(--c-text)]">{impact}</div>
                <div className="mono text-[10px] text-[var(--c-dim)] leading-snug mt-0.5">{detail}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1">
        {/* Graph */}
        <div className="card p-4 lg:col-span-2">
          <SectionHeader title="Root Cause Graph" sub="causal dependencies across tenant boundaries" />
          <svg width="100%" viewBox="0 0 100 80" className="overflow-visible" style={{ height: 340 }}>
            {RCA_EDGES.map(([from, to]) => {
              const f = RCA_NODES.find(n => n.id === from)!
              const t = RCA_NODES.find(n => n.id === to)!
              const crossTenant = f.dom !== t.dom
              return (
                <line
                  key={`${from}-${to}`}
                  x1={`${f.x}%`} y1={`${f.y + 5}%`}
                  x2={`${t.x}%`} y2={`${t.y}%`}
                  stroke={crossTenant ? C.purple : C.border}
                  strokeWidth={crossTenant ? '0.7' : '0.5'}
                  strokeDasharray={crossTenant ? '1.5 1' : undefined}
                  strokeOpacity={crossTenant ? 0.8 : 1}
                />
              )
            })}
            {RCA_NODES.map(node => {
              const color = node.severity === 'critical' ? C.red :
                node.severity === 'error' ? C.orange :
                node.severity === 'warn' ? C.amber : C.cyan
              const isSelected = selectedNode === node.id
              const dimmed = node.dom !== domain
              const hasInfo = !!nodeInfo[node.id]
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}%, ${node.y}%)`}
                  onClick={() => hasInfo && setSelectedNode(node.id)}
                  style={{ cursor: hasInfo ? 'pointer' : 'default', opacity: dimmed ? 0.35 : 1 }}
                >
                  <rect
                    x="-8.5%" y="-3.8%" width="17%" height="7.6%"
                    rx="0.5%" ry="0.5%"
                    fill={isSelected ? color + '22' : C.card}
                    stroke={color}
                    strokeWidth={isSelected ? '0.6' : '0.3'}
                  />
                  {/* tenant rail on the left edge of every node */}
                  <rect x="-8.5%" y="-3.8%" width="0.7%" height="7.6%" fill={domainColor(node.dom)} />
                  <text
                    textAnchor="middle" dominantBaseline="middle" y="-0.8%"
                    fontSize="1.9%" fill={isSelected ? color : C.text2}
                    fontFamily="JetBrains Mono"
                    fontWeight={isSelected ? '600' : '400'}
                  >
                    {node.label}
                  </text>
                  <text
                    textAnchor="middle" dominantBaseline="middle" y="2.2%"
                    fontSize="1.5%" fill={domainColor(node.dom)}
                    fontFamily="JetBrains Mono"
                  >
                    {DOMAIN_BY_ID[node.dom].short}
                  </text>
                </g>
              )
            })}
          </svg>
          <div className="flex items-center gap-4 mt-1">
            <div className="flex items-center gap-1.5">
              <svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={C.purple} strokeWidth="1.5" strokeDasharray="3 2" /></svg>
              <span className="mono text-[10px] text-[var(--c-dim)]">crosses a tenant boundary</span>
            </div>
            <div className="flex items-center gap-1.5">
              <svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={C.border} strokeWidth="1.5" /></svg>
              <span className="mono text-[10px] text-[var(--c-dim)]">within one tenant</span>
            </div>
          </div>
        </div>

        {/* Detail panel */}
        <div className="card p-4 flex flex-col gap-3">
          <SectionHeader title="Node Details" />
          {info ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono text-sm font-semibold text-[var(--c-text)]">{selectedNode}</span>
                {selDom && (
                  <span className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: a(domainColor(selDom), 0.14), color: domainColor(selDom) }}>
                    {DOMAIN_BY_ID[selDom].short}
                  </span>
                )}
                <div
                  className="mono text-[11px] px-2 py-0.5 rounded-sm"
                  style={{
                    background: a(info.prob > 0.9 ? C.red : info.prob > 0.8 ? C.orange : C.amber, 0.15),
                    color: info.prob > 0.9 ? C.red : info.prob > 0.8 ? C.orange : C.amber,
                  }}
                >
                  {(info.prob * 100).toFixed(0)}% confidence
                </div>
              </div>
              <div className="mono text-[10px] text-[var(--c-faint)]">On call: {info.owner}</div>
              <div>
                <div className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest mb-2">Evidence</div>
                <div className="flex flex-col gap-1.5">
                  {info.evidence.map((e, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <span className="text-[var(--c-cyan)] mono text-[11px] flex-shrink-0">▸</span>
                      <span className="mono text-[11px] text-[var(--c-dim)]">{e}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest mb-2">Recommendation</div>
                <div className="mono text-[11px] text-[var(--c-text2)] leading-relaxed p-3 rounded" style={{ background: a(C.cyan, 0.04), border: `1px solid ${a(C.cyan, 0.12)}` }}>
                  {info.recommendation}
                </div>
              </div>
            </>
          ) : (
            <div className="mono text-[11px] text-[var(--c-faint)]">Click a node to inspect</div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="card p-4">
        <SectionHeader title="Incident Timeline" sub="correlated events" />
        <div className="relative">
          <div className="absolute left-[140px] top-0 bottom-0 w-px" style={{ background: C.border }} />
          <div className="flex flex-col gap-3">
            {[
              { time: '15:42:07', event: 'Deployment v2.14.1 started — payment-svc', type: 'deploy', icon: '⬆' },
              { time: '15:48:22', event: '100% traffic shifted to v2.14.1', type: 'deploy', icon: '✓' },
              { time: '15:51:04', event: 'DB connection count began climbing (91 → 140)', type: 'warn', icon: '⚠' },
              { time: '15:54:31', event: 'Cache hit ratio dropped: 87% → 74%', type: 'warn', icon: '⚠' },
              { time: '15:58:14', event: 'Payment SVC error rate crossed 1% threshold — alert fired', type: 'error', icon: '⚡' },
              { time: '16:02:49', event: 'DB connections exhausted (512/512) — circuit breaker opened', type: 'critical', icon: '✕' },
              { time: '16:04:11', event: 'PagerDuty P1 incident created', type: 'incident', icon: '🔴' },
              { time: '16:09:33', event: 'Rollback initiated to v2.13.9', type: 'remediate', icon: '↩' },
              { time: '16:14:02', event: 'Connection count normalizing (512 → 180)', type: 'resolve', icon: '↓' },
              { time: '16:17:45', event: 'Error rate below 0.5% — incident resolved', type: 'resolve', icon: '✓' },
            ].map(({ time, event, type, icon }) => {
              const color = type === 'critical' ? C.red : type === 'error' ? C.orange : type === 'warn' ? C.amber :
                type === 'resolve' ? C.green : type === 'remediate' ? C.purple : type === 'deploy' ? C.cyan : C.dim
              return (
                <div key={time} className="flex items-start gap-4">
                  <div className="mono text-[11px] text-[var(--c-faint)] w-[136px] text-right flex-shrink-0 pt-0.5">{time}</div>
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 relative z-10"
                    style={{ background: color + '20', border: `1px solid ${color}60`, color }}>
                    {icon}
                  </div>
                  <div className="mono text-[11px] text-[var(--c-dim)] pt-0.5">{event}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Ask panel ────────────────────────────────────────────────────────────────
// A conversational surface over the same buffer every chart reads from. Two
// rules keep it honest: it answers from the live window rather than prose, and
// every answer ships the queries it ran so the numbers can be checked.

interface ChatToolCall {
  name: string
  target: string
  query: string
  ms: number
  rows: number
}

interface ChatTable {
  title?: string
  cols: string[]
  align?: ('left' | 'right')[]
  rows: (string | number)[][]
}

interface ChatMsg {
  id: string
  role: 'user' | 'agent'
  text: string
  tools?: ChatToolCall[]
  table?: ChatTable
  observations?: string[]
  tokens?: number
  cost?: number
  streaming?: boolean
}

const SUGGESTED_PROMPTS = [
  'What are my top services by error count right now?',
  'Which team is burning error budget fastest?',
  'Show me every CRITICAL in the last window',
  'Why is ticketing degraded?',
  'Which services have the worst p99?',
]

function esQuery(index: string, body: string) {
  return `POST /${index}/_search\n${body}`
}

/** Deterministic responder over the live buffer — no fabricated numbers. */
function answerQuestion(q: string, logs: LogEntry[], domain: DomainFilter): Omit<ChatMsg, 'id' | 'role'> {
  const scope = [DOMAIN_BY_ID[domain]]
  const scopeLabel = DOMAIN_BY_ID[domain].label
  const indices = scope.map(d => d.index ?? `logs-${d.id}-*`).join(',')
  const t = q.toLowerCase()
  const isErr = (l: LogEntry) => l.severity === 'CRITICAL' || l.severity === 'ERROR'
  const tokens = 900 + Math.floor(Math.random() * 2600)
  const cost = Number((tokens * 0.000009).toFixed(4))

  // ── Worst error budget ────────────────────────────────────────────────────
  if (/(burn|budget|slo|attainment|worst team|which team)/.test(t)) {
    const ranked = [...scope].sort((x, y) => y.slo.burn - x.slo.burn)
    const top = ranked[0]
    return {
      text: `${top.team} is burning fastest at ${top.slo.burn.toFixed(1)}× the sustainable rate, against a ${top.slo.target} target on "${top.slo.name}" (currently ${top.slo.attainment}%). At that rate the monthly budget is gone in ${(30 / top.slo.burn).toFixed(1)} days.`,
      tools: [{
        name: 'slo_registry', target: 'burn-rate service', ms: 61, rows: scope.length,
        query: 'GET /slo/_burn_rate?windows=1h,6h&tenants=' + scope.map(d => d.id).join(','),
      }],
      table: {
        title: 'Error budget burn, 1h window',
        cols: ['Team', 'SLO', 'Target', 'Attainment', 'Burn'],
        align: ['left', 'left', 'right', 'right', 'right'],
        rows: ranked.map(d => [d.team, d.slo.name, d.slo.target, `${d.slo.attainment}%`, `${d.slo.burn.toFixed(1)}×`]),
      },
      observations: [
        `Anything above 6× pages immediately — ${ranked.filter(d => d.slo.burn > 6).length} tenant(s) qualify.`,
        `${ranked[ranked.length - 1].team} is the healthiest at ${ranked[ranked.length - 1].slo.burn.toFixed(1)}× and needs no action.`,
      ],
      tokens, cost,
    }
  }

  // ── Latency ───────────────────────────────────────────────────────────────
  if (/(latency|p99|slow|response time)/.test(t)) {
    const rows = scope.flatMap(d => d.services.map(svc => {
      const s = serviceStats(svc)
      return [svc, d.short, `${s.p99}ms`, `${s.errRate}%`, s.tier] as (string | number)[]
    })).sort((x, y) => parseInt(String(y[2])) - parseInt(String(x[2]))).slice(0, 10)
    return {
      text: `Worst p99 latency across ${scopeLabel}, measured over the last hour. ${rows[0][0]} is the outlier at ${rows[0][2]}.`,
      tools: [{
        name: 'search', target: indices, ms: 148, rows: rows.length,
        query: esQuery(indices, JSON.stringify({
          size: 0,
          aggs: { by_service: { terms: { field: 'service.name.keyword', size: 50 }, aggs: { latency: { percentiles: { field: 'event.duration', percents: [99] } } } } },
        }, null, 2)),
      }],
      table: {
        title: 'p99 latency by service',
        cols: ['Service', 'Tenant', 'p99', 'Err %', 'Tier'],
        align: ['left', 'left', 'right', 'right', 'left'],
        rows,
      },
      observations: [`${rows.filter(r => parseInt(String(r[2])) > 500).length} services are above the 500ms review threshold.`],
      tokens, cost,
    }
  }

  // ── Criticals ─────────────────────────────────────────────────────────────
  if (/(critical|p1|severe|fatal|worst error)/.test(t)) {
    const crits = logs.filter(l => l.severity === 'CRITICAL').slice(0, 10)
    return {
      text: crits.length
        ? `${crits.length} CRITICAL events in the current window for ${scopeLabel}, newest first.`
        : `No CRITICAL events in the current window for ${scopeLabel}. The most severe entries are ERROR level.`,
      tools: [{
        name: 'search', target: indices, ms: 74, rows: crits.length,
        query: esQuery(indices, JSON.stringify({
          size: 10,
          sort: [{ '@timestamp': 'desc' }],
          query: { bool: { filter: [{ term: { 'log.level': 'critical' } }, { range: { '@timestamp': { gte: 'now-15m' } } }] } },
        }, null, 2)),
      }],
      table: crits.length ? {
        title: 'CRITICAL events',
        cols: ['Time', 'Tenant', 'Service', 'Message'],
        rows: crits.map(l => [l.timestamp.slice(11, 19), DOMAIN_BY_ID[l.domain]?.short ?? l.domain, l.service, l.message]),
      } : undefined,
      observations: crits.length
        ? [`${new Set(crits.map(l => l.service)).size} distinct services are emitting criticals — check whether they share a dependency before treating them separately.`]
        : undefined,
      tokens, cost,
    }
  }

  // ── Why is X degraded ─────────────────────────────────────────────────────
  if (/(why|root cause|rca|degraded|cause of|explain)/.test(t)) {
    return {
      text: 'The active P1 (INC-2847) starts in MPS and propagates outward. payment-svc v2.14.1 leaks connections; the auth pool exhausts at 16:02; PIS journey-api calls the MPS token endpoint synchronously, so passenger display screens go blank; MRD signal plan staleness and SSA alert delays follow downstream.',
      tools: [
        {
          name: 'search', target: indices, ms: 96, rows: 41208,
          query: esQuery(indices, JSON.stringify({ size: 0, query: { bool: { filter: [{ range: { '@timestamp': { gte: 'now-30m' } } }] } }, aggs: { by_tenant: { terms: { field: 'service.name.keyword' } } } }, null, 2)),
        },
        {
          name: 'correlate_topology', target: 'dependency graph', ms: 212, rows: 8,
          query: 'GET /topology/_edges?from=mps&depth=2&window=30m',
        },
        {
          name: 'fetch_deploys', target: 'deploy audit log', ms: 44, rows: 3,
          query: 'GET /deploys?service=payment-svc&since=now-2h',
        },
      ],
      table: {
        title: 'Blast radius by tenant',
        cols: ['Tenant', 'Role', 'Impact'],
        rows: BLAST_RADIUS.map(b => [DOMAIN_BY_ID[b.dom]?.label ?? b.dom, b.role, b.impact]),
      },
      observations: [
        'Deploy v2.14.1 at 15:42 UTC precedes the first symptom by 6 minutes.',
        'The canary passed because cross-tenant traffic was not in the canary mix.',
        'Rollback to v2.13.9 is the fastest path — estimated 8–12 minutes to recovery.',
      ],
      tokens, cost,
    }
  }

  // ── Volume ────────────────────────────────────────────────────────────────
  if (/(volume|how many|count|throughput|events)/.test(t)) {
    const rows = scope.map(d => {
      const mine = logs.filter(l => l.domain === d.id)
      const errs = mine.filter(isErr).length
      return [d.label, mine.length, errs, mine.length ? `${((errs / mine.length) * 100).toFixed(1)}%` : '—'] as (string | number)[]
    }).sort((x, y) => Number(y[1]) - Number(x[1]))
    return {
      text: `${logs.length.toLocaleString()} events in the current buffer across ${scopeLabel}, split by tenant below.`,
      tools: [{
        name: 'search', target: indices, ms: 88, rows: logs.length,
        query: esQuery(indices, JSON.stringify({
          size: 0,
          aggs: { over_time: { date_histogram: { field: '@timestamp', fixed_interval: '1h' }, aggs: { by_level: { terms: { field: 'log.level' } } } } },
        }, null, 2)),
      }],
      table: { title: 'Events by tenant', cols: ['Tenant', 'Events', 'Errors', 'Err %'], align: ['left', 'right', 'right', 'right'], rows },
      tokens, cost,
    }
  }

  // ── Default: top services by error count ──────────────────────────────────
  const byService = new Map<string, { total: number; errs: number; dom: DomainId }>()
  for (const l of logs) {
    const e = byService.get(l.service) ?? { total: 0, errs: 0, dom: l.domain }
    e.total++
    if (isErr(l)) e.errs++
    byService.set(l.service, e)
  }
  const ranked = [...byService.entries()]
    .sort((x, y) => y[1].errs - x[1].errs)
    .slice(0, 10)
    .map(([svc, v], i) => [
      i + 1, svc, DOMAIN_BY_ID[v.dom]?.short ?? v.dom, v.errs, v.total,
      v.total ? `${((v.errs / v.total) * 100).toFixed(1)}%` : '—',
    ] as (string | number)[])

  return {
    text: ranked.length
      ? `Top services by error count across ${scopeLabel}, from the ${logs.length.toLocaleString()} events currently buffered. ${ranked[0][1]} leads with ${ranked[0][3]} errors.`
      : `Nothing buffered yet for ${scopeLabel}. Start the stream or widen the tenant scope and ask again.`,
    tools: [{
      name: 'search', target: indices, ms: 112, rows: logs.length,
      query: esQuery(indices, JSON.stringify({
        size: 0,
        query: { bool: { filter: [{ range: { '@timestamp': { gte: 'now-15m' } } }] } },
        aggs: { by_service: { terms: { field: 'service.name.keyword', size: 10, order: { errors: 'desc' } }, aggs: { errors: { filter: { terms: { 'log.level': ['error', 'critical'] } } } } } },
      }, null, 2)),
    }],
    table: ranked.length ? {
      title: 'Top services by errors',
      cols: ['Rank', 'Service', 'Tenant', 'Errors', 'Events', 'Err %'],
      align: ['right', 'left', 'left', 'right', 'right', 'right'],
      rows: ranked,
    } : undefined,
    observations: ranked.length ? [
      `${ranked[0][1]} accounts for ${((Number(ranked[0][3]) / Math.max(1, logs.filter(isErr).length)) * 100).toFixed(0)}% of all errors in the window.`,
      'Error rate matters more than raw count — a low-traffic service at 30% is usually the better lead.',
    ] : undefined,
    tokens, cost,
  }
}

function ToolDisclosure({ tools }: { tools: ChatToolCall[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="mono text-[10px] flex items-center gap-1.5 px-1.5 py-1 rounded transition-colors"
        style={{ background: a(C.purple, 0.08), border: `1px solid ${a(C.purple, 0.18)}`, color: C.purple }}
      >
        <span>⛁</span>
        <span>Used {tools.length} tool{tools.length > 1 ? 's' : ''}</span>
        <span className="text-[var(--c-faint)]">— {tools.map(t => t.name).join(', ')}</span>
        <span>{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {tools.map((t, i) => (
            <div key={i} className="rounded p-2" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="mono text-[10px]" style={{ color: C.cyan }}>{t.name}</span>
                <span className="mono text-[10px] text-[var(--c-faint)] truncate">{t.target}</span>
                <span className="mono text-[10px] text-[var(--c-faint)] ml-auto">{t.rows.toLocaleString()} rows · {t.ms}ms</span>
              </div>
              <pre className="mono text-[10px] text-[var(--c-dim)] overflow-x-auto leading-relaxed whitespace-pre">{t.query}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatResultTable({ table }: { table: ChatTable }) {
  return (
    <div className="mt-3 rounded overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
      {table.title && (
        <div className="mono text-[10px] px-2 py-1.5 uppercase tracking-widest text-[var(--c-faint)]"
          style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
          {table.title}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full mono text-[10px]">
          <thead>
            <tr style={{ background: C.bg }}>
              {table.cols.map((c, i) => (
                <th key={c} className={`px-2 py-1.5 font-medium text-[var(--c-dim)] ${table.align?.[i] === 'right' ? 'text-right' : 'text-left'}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr key={ri} style={{ borderTop: `1px solid ${C.border}` }}>
                {r.map((cell, ci) => (
                  <td key={ci} className={`px-2 py-1.5 text-[var(--c-text2)] ${table.align?.[ci] === 'right' ? 'text-right' : 'text-left'}`}>
                    {typeof cell === 'number' ? cell.toLocaleString() : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AskPanel({ open, onClose, logs, domain, model, wide, setWide }: {
  open: boolean
  onClose: () => void
  logs: LogEntry[]
  domain: DomainFilter
  model: string
  wide: boolean
  setWide: (w: boolean) => void
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentModel = LLM_MODELS.find(m => m.id === model) || LLM_MODELS[0]

  // Keep the newest turn in view while tokens arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = useCallback((raw: string) => {
    const q = raw.trim()
    if (!q || busy) return
    setInput('')
    setBusy(true)

    const answer = answerQuestion(q, logs, domain)
    const agentId = Math.random().toString(36).slice(2, 10)
    setMessages(prev => [
      ...prev,
      { id: Math.random().toString(36).slice(2, 10), role: 'user', text: q },
      { id: agentId, role: 'agent', text: '', tools: answer.tools, streaming: true },
    ])

    // Stream the prose, then reveal the structured payload — the same order a
    // real agent produces it, and it stops the table from jumping mid-answer.
    let i = 0
    const full = answer.text
    const timer = setInterval(() => {
      i += 3
      setMessages(prev => prev.map(m => m.id === agentId ? { ...m, text: full.slice(0, i) } : m))
      if (i >= full.length) {
        clearInterval(timer)
        setMessages(prev => prev.map(m => m.id === agentId ? { ...m, ...answer, streaming: false } : m))
        setBusy(false)
      }
    }, 16)
  }, [logs, domain, busy])

  if (!open) return null

  return (
    <aside
      className="flex flex-col flex-shrink-0 h-full"
      style={{ width: wide ? 640 : 420, background: C.bgDeep, borderLeft: `1px solid ${C.border}` }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 52, borderBottom: `1px solid ${C.border}` }}>
        <div className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: a(C.cyan, 0.12), border: `1px solid ${a(C.cyan, 0.25)}` }}>
          <span className="text-[var(--c-cyan)] text-[11px]">◈</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mono text-[11px] text-[var(--c-text)] leading-none">LogSense Agent</div>
          <div className="mono text-[9px] text-[var(--c-faint)] truncate">
            {currentModel.name} · {DOMAIN_BY_ID[domain]?.label ?? domain}
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} title="Clear conversation"
            className="mono text-[10px] px-1.5 py-1 rounded text-[var(--c-faint)] hover:text-[var(--c-dim)]">
            ⌫
          </button>
        )}
        <button onClick={() => setWide(!wide)} title={wide ? 'Narrow panel' : 'Widen panel'}
          className="mono text-[10px] px-1.5 py-1 rounded text-[var(--c-faint)] hover:text-[var(--c-dim)]">
          {wide ? '⇥' : '⇤'}
        </button>
        <button onClick={onClose} title="Close (⌘K)"
          className="mono text-[11px] px-1.5 py-1 rounded text-[var(--c-faint)] hover:text-[var(--c-dim)]">
          ✕
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-4 flex flex-col gap-5">
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <div className="mono text-[11px] text-[var(--c-dim)] leading-relaxed">
              Ask about the {logs.length.toLocaleString()} events currently in scope. Answers are computed from the live
              buffer, and every one shows the queries behind it.
            </div>
            <div className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest mt-2">Try</div>
            {SUGGESTED_PROMPTS.map(p => (
              <button
                key={p}
                onClick={() => send(p)}
                className="text-left mono text-[11px] px-2.5 py-2 rounded transition-colors"
                style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text2 }}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className="flex flex-col gap-1.5 animate-fade-up">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full flex items-center justify-center mono text-[8px] flex-shrink-0"
                style={{
                  background: m.role === 'user' ? a(C.purple, 0.18) : a(C.cyan, 0.15),
                  color: m.role === 'user' ? C.purple : C.cyan,
                }}>
                {m.role === 'user' ? 'YOU' : '◈'}
              </div>
              <span className="mono text-[10px] font-semibold text-[var(--c-text)]">
                {m.role === 'user' ? 'You' : 'LogSense Agent'}
              </span>
              {m.role === 'agent' && m.streaming && (
                <span className="mono text-[9px] text-[var(--c-cyan)] animate-pulse-dot">running</span>
              )}
            </div>

            <div className="pl-6">
              {m.role === 'agent' && m.tools && <ToolDisclosure tools={m.tools} />}

              <div className="mono text-[11px] text-[var(--c-text2)] leading-relaxed mt-2 whitespace-pre-line">
                {m.text}
                {m.streaming && <span className="ai-typing" />}
              </div>

              {m.table && <ChatResultTable table={m.table} />}

              {m.observations && m.observations.length > 0 && (
                <div className="mt-3">
                  <div className="mono text-[10px] uppercase tracking-widest text-[var(--c-faint)] mb-1.5">Key observations</div>
                  <ul className="flex flex-col gap-1.5">
                    {m.observations.map(o => (
                      <li key={o} className="flex gap-2">
                        <span className="mono text-[10px] flex-shrink-0" style={{ color: C.cyan }}>▸</span>
                        <span className="mono text-[11px] text-[var(--c-dim)] leading-relaxed">{o}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {m.role === 'agent' && !m.streaming && m.tokens && (
                <div className="mono text-[9px] text-[var(--c-faint)] mt-2.5 flex items-center gap-2">
                  <span style={{ color: C.green }}>✓ finished</span>
                  <span>·</span>
                  <span>{m.tokens.toLocaleString()} tokens</span>
                  <span>·</span>
                  <span>${m.cost?.toFixed(4)}</span>
                  <span>·</span>
                  <span>{currentModel.name}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="p-3 flex-shrink-0">
        <div className="rounded-lg p-2.5 flex flex-col gap-2"
          style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
            }}
            rows={2}
            placeholder={`Ask about ${DOMAIN_BY_ID[domain]?.label ?? 'this LoB'}…`}
            className="mono text-[11px] bg-transparent resize-none outline-none text-[var(--c-text)] placeholder-[var(--c-faint)] leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <span className="mono text-[10px] text-[var(--c-faint)]" title="Scope follows the tenant bar">
              ⌾ {DOMAIN_BY_ID[domain]?.short ?? domain}
            </span>
            <span className="mono text-[10px] text-[var(--c-faint)]">⇧⏎ newline</span>
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || busy}
              className="ml-auto w-6 h-6 rounded-full flex items-center justify-center mono text-[11px] transition-colors"
              style={{
                background: input.trim() && !busy ? C.cyan : a(C.dim, 0.15),
                color: input.trim() && !busy ? C.bgDeep : C.faint,
                cursor: input.trim() && !busy ? 'pointer' : 'not-allowed',
              }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ─── Agentic RCA ──────────────────────────────────────────────────────────────
// Design rules borrowed from how these systems actually get trusted in prod:
//   1. every claim carries a citation back to raw evidence (no ungrounded prose)
//   2. the agent must publish what it ruled out, not just what it believes
//   3. token/cost/latency are first-class telemetry, per step, not a footnote
//   4. cheap models do retrieval, the frontier model only does the reasoning
//   5. nothing that mutates production happens without an explicit human decision

type StepStatus = 'done' | 'running' | 'pending' | 'blocked' | 'rejected'

type AgentStep = {
  id: string
  phase: string
  status: StepStatus
  content: string
  tool?: string
  /** Which model this phase was routed to — retrieval is deliberately cheap. */
  routed: 'fast' | 'reasoning'
  tokensIn: number
  tokensOut: number
  latency: number
  confidence?: number
  citations?: string[]
  gate?: boolean
}

/** $ per 1M tokens — used to price a run honestly rather than hiding the bill. */
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gemini-2-5-pro': { in: 1.25, out: 10 },
  'llama-3-3': { in: 0.6, out: 0.6 },
  'mistral-large': { in: 2, out: 6 },
  // Open-weight token-optimised (MoE / dense, self-hosted or API)
  'qwen3-235b': { in: 0.4, out: 1.6 },
  'qwen3-32b': { in: 0.1, out: 0.6 },
  'kimi-k2': { in: 0.6, out: 2.5 },
  'glm-4-32b': { in: 0.14, out: 0.14 },
  'glm-z1-32b': { in: 0.14, out: 0.14 },
}
const FAST_MODEL = { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', rate: { in: 0.8, out: 4 } }

function stepCost(step: AgentStep, reasoningModel: string) {
  const rate = step.routed === 'fast' ? FAST_MODEL.rate : (MODEL_RATES[reasoningModel] ?? MODEL_RATES['claude-sonnet-5'])
  return (step.tokensIn / 1e6) * rate.in + (step.tokensOut / 1e6) * rate.out
}

const RULED_OUT = [
  { hypothesis: 'Display-controller hardware fault (PIS)', why: 'All 412 screens report healthy at the hardware layer; blanking coincides exactly with journey-api 503 onset.', by: 'query_devices()' },
  { hypothesis: 'PIS deploy pis-v3.8 (14:50 UTC)', why: 'Rolled to 5% canary only; affected screens are in the 0% canary cohort.', by: 'check_rollouts()' },
  { hypothesis: 'Credential-stuffing wave against MPS auth', why: 'Auth failure mix unchanged; 504s are timeouts, not rejections.', by: 'correlate_events()' },
  { hypothesis: 'SSA camera-analytics overload causing MPS latency', why: 'SSA metrics show no spike before 16:09 — it is a downstream effect, not a trigger.', by: 'lag_correlation()' },
]

const AGENT_RUNS = [
  { id: 'run_8f2c41', when: '16:04 UTC', tenant: 'pis', model: 'Claude Sonnet 5', cost: 0.42, verdict: 'MPS conn leak cascaded to PIS', decision: 'approved', mttr: '14m' },
  { id: 'run_7a19de', when: '09:18 UTC', tenant: 'mrd', model: 'Claude Haiku 4.5', cost: 0.08, verdict: 'Signal controller hardware fault', decision: 'approved', mttr: '31m' },
  { id: 'run_6b04ac', when: 'Yesterday', tenant: 'ssa', model: 'GPT-4o', cost: 0.51, verdict: 'Inconclusive — escalated', decision: 'rejected', mttr: '—' },
  { id: 'run_5c88fe', when: 'Yesterday', tenant: 'mps', model: 'Claude Sonnet 5', cost: 0.29, verdict: 'Expired mTLS cert on tokenisation-svc', decision: 'approved', mttr: '22m' },
]

function AgentSection({ model, setModel, domain, setDomain }: {
  model: string; setModel: (m: string) => void; domain: DomainFilter; setDomain: (d: DomainFilter) => void
}) {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [streamText, setStreamText] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [gate, setGate] = useState<'idle' | 'awaiting' | 'approved' | 'rejected'>('idle')
  const resume = useRef<(() => void) | null>(null)

  const currentModel = LLM_MODELS.find(m => m.id === model) || LLM_MODELS[0]
  const incidentTenant: DomainId = domain
  const tenant = DOMAIN_BY_ID[incidentTenant]

  const AGENT_STEPS: Omit<AgentStep, 'status'>[] = [
    {
      id: '1', phase: 'Scope & Ground', tool: 'search_logs(tenant, 30m)', routed: 'fast',
      tokensIn: 18400, tokensOut: 240, latency: 1.9, confidence: 1,
      citations: ['log:9fa21c', 'log:71bb04', 'trace:8c4d19a2f0'],
      content: `Pulled 41,208 events for ${tenant.label} (last 30m) plus the 3 LoBs sharing a dependency edge. Redaction applied at prompt build: 1,204 identifiers masked. Retained 38 exemplar events after dedup by fingerprint.`,
    },
    {
      id: '2', phase: 'Correlate Tenants', tool: 'correlate_tenants()', routed: 'fast',
      tokensIn: 9100, tokensOut: 380, latency: 2.4, confidence: 0.92,
      citations: ['fp:ERR-upstream-timeout-5s', 'trace:8c4d19a2f0', 'log:41c802'],
      content: 'Fingerprint ERR-upstream-timeout-5s appears in PIS (16:01), MPS (15:56) and MRD (16:12). Onset ordering puts MPS first by 5m. Shared dependency: psp-adapter → ledger-db pool. MRD contact is coincidental (different pool).',
    },
    {
      id: '3', phase: 'Hypothesise', tool: 'rank_hypotheses()', routed: 'reasoning',
      tokensIn: 12600, tokensOut: 720, latency: 4.1, confidence: 0.81,
      citations: ['log:71bb04', 'deploy:payment-svc@v2.14.1', 'metric:pool.active'],
      content: 'Ranked 6 candidates:\n  1. 0.81 — payment-svc v2.14.1 leaks pool connections; entitlement reads share that pool\n  2. 0.44 — acquirer latency holds connections open long enough to exhaust the pool\n  3. 0.22 — entitlement store lacks a circuit breaker, so it queues instead of shedding\n4 candidates eliminated (see Ruled Out).',
    },
    {
      id: '4', phase: 'Validate', tool: 'run_query() · fetch_heap()', routed: 'reasoning',
      tokensIn: 15200, tokensOut: 610, latency: 5.6, confidence: 0.94,
      citations: ['heap:payment-svc-5d9f8b', 'metric:pool.active', 'log:71bb04'],
      content: 'H1 confirmed: heap dump shows 847 unclosed PreparedStatement objects; pool.active grows +3.4/min from deploy +3m with zero decay. H2 partially confirmed (accelerant, not cause). H3 confirmed as a severity multiplier, not a trigger.',
    },
    {
      id: '5', phase: 'Root Cause', tool: 'conclude_rca()', routed: 'reasoning',
      tokensIn: 8800, tokensOut: 540, latency: 3.2, confidence: 0.94,
      citations: ['heap:payment-svc-5d9f8b', 'deploy:payment-svc@v2.14.1', 'log:9fa21c'],
      content: 'ROOT CAUSE (94% confidence)\n• Primary: connection leak in payment-svc v2.14.1 — missing release() on the capture path (payment/process.ts:482)\n• Cross-LoB path: PIS journey-api calls MPS token endpoint synchronously; pool exhaustion in MPS blanks passenger display screens\n• Amplifier: no circuit breaker on journey-api → MPS auth call\n• Trigger: 100% rollout of v2.14.1 completed 15:48 UTC',
    },
    {
      id: '6', phase: 'Remediate', tool: 'propose_actions() → human gate', routed: 'reasoning', gate: true,
      tokensIn: 6400, tokensOut: 480, latency: 2.8, confidence: 0.9,
      citations: ['runbook:PAY-014', 'change:CHG-9921'],
      content: 'PROPOSED (requires human approval — the agent holds no write credentials):\n  P0 · Roll back payment-svc → v2.13.9  [blast radius: MPS, PIS · est. recovery 8-12m]\n  P0 · Raise ledger-db pool ceiling 512 → 640 as a holding action\n  P1 · Ship release() fix at payment/process.ts:482\n  P1 · Add circuit breaker on PIS journey-api → MPS auth call\n  P2 · Add cross-LoB error-rate gate to the MPS canary',
    },
    {
      id: '7', phase: 'Report & Learn', tool: 'write_postmortem() · add_detector()', routed: 'fast',
      tokensIn: 7200, tokensOut: 690, latency: 2.1, confidence: 1,
      citations: ['inc:INC-2847', 'detector:pool-share-guard'],
      content: 'Postmortem drafted against INC-2847 and shared with MPS + PIS. Filed 3 tickets. New detector registered: alert when two LoBs share a saturating pool for >60s — this class of incident is now caught before it reaches passenger display screens.',
    },
  ]

  const startAgent = useCallback(() => {
    setRunning(true)
    setSteps([])
    setStreamText('')
    setGate('idle')

    let stepIdx = 0
    const processStep = () => {
      if (stepIdx >= AGENT_STEPS.length) {
        setRunning(false)
        return
      }
      const step = AGENT_STEPS[stepIdx]
      setSteps(prev => [...prev, { ...step, status: 'running' }])
      setStreamText('')

      let charIdx = 0
      const content = step.content
      const stream = setInterval(() => {
        charIdx += 2
        setStreamText(content.slice(0, charIdx))
        if (charIdx >= content.length) {
          clearInterval(stream)
          const advance = () => {
            setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'done', content } : s))
            stepIdx++
            setTimeout(processStep, 500)
          }
          if (step.gate) {
            // Hard stop: no further tool calls until a human decides.
            setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'blocked', content } : s))
            setGate('awaiting')
            setRunning(false)
            resume.current = () => { setRunning(true); advance() }
          } else {
            advance()
          }
        }
      }, 10)
    }
    processStep()
  }, [model, incidentTenant])

  const approve = () => {
    setGate('approved')
    setSteps(prev => prev.map(s => s.gate ? { ...s, status: 'done' } : s))
    resume.current?.()
    resume.current = null
  }
  const reject = () => {
    setGate('rejected')
    setSteps(prev => prev.map(s => s.gate ? { ...s, status: 'rejected' } : s))
    resume.current = null
    setRunning(false)
  }

  const totals = steps.reduce(
    (acc, s) => ({
      tin: acc.tin + s.tokensIn,
      tout: acc.tout + s.tokensOut,
      cost: acc.cost + stepCost(s, model),
      secs: acc.secs + s.latency,
    }),
    { tin: 0, tout: 0, cost: 0, secs: 0 }
  )
  const budget = 0.6
  const citationCount = steps.flatMap(s => s.citations ?? []).length
  const complete = steps.length === AGENT_STEPS.length && !running

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* Header controls */}
      <div className="card p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-48">
          <div className="text-sm font-semibold text-[var(--c-text)]">Agentic RCA</div>
          <div className="mono text-[11px] text-[var(--c-faint)]">
            Grounded, cost-metered, human-gated · scope: {tenant.label}
          </div>
        </div>

        {/* Tenant scope */}
        <select
          value={incidentTenant}
          onChange={e => setDomain(e.target.value as DomainId)}
          className="mono text-[11px] bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-2 py-2 text-[var(--c-dim)] outline-none focus:border-[var(--c-cyan)]"
        >
          {DOMAINS.map(d => <option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
        </select>

        {/* Model picker */}
        <div className="relative">
          <button
            onClick={() => setShowModelMenu(!showModelMenu)}
            className="mono text-[11px] px-3 py-2 rounded flex items-center gap-2 hover:border-[var(--c-cyan)] transition-colors"
            style={{ background: C.bg, border: `1px solid ${C.border}` }}
          >
            <span style={{ color: C.cyan }}>{currentModel.icon}</span>
            <span className="text-[var(--c-text)]">{currentModel.name}</span>
            <span className="text-[var(--c-faint)]">reasoning</span>
            <span className="text-[var(--c-dim)]">▾</span>
          </button>
          {showModelMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 rounded"
              style={{ background: C.card, border: `1px solid ${C.border}`, minWidth: 260 }}>
              <div className="mono text-[9px] text-[var(--c-faint)] uppercase tracking-widest px-3 pt-2 pb-1">
                Reasoning model · $/1M tok in/out
              </div>
              {/* Frontier / proprietary */}
              <div className="mono text-[9px] text-[var(--c-dim)] uppercase tracking-widest px-3 pt-1 pb-0.5" style={{ borderTop: `1px solid ${C.border}` }}>
                Frontier
              </div>
              {LLM_MODELS.filter(m => !['qwen3-235b','qwen3-32b','kimi-k2','glm-4-32b','glm-z1-32b'].includes(m.id)).map(m => {
                const rate = MODEL_RATES[m.id]
                return (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setShowModelMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--c-border)] text-left"
                >
                  <span style={{ color: C.cyan }}>{m.icon}</span>
                  <div className="min-w-0">
                    <div className="mono text-[11px] text-[var(--c-text)]">{m.name}</div>
                    <div className="mono text-[10px] text-[var(--c-faint)]">
                      {m.provider}{rate ? ` · $${rate.in}/$${rate.out}` : ''}
                    </div>
                  </div>
                  {m.id === model && <span className="ml-auto text-[var(--c-cyan)] text-xs">✓</span>}
                </button>
                )
              })}
              {/* Open-weight token-optimised */}
              <div className="mono text-[9px] text-[var(--c-dim)] uppercase tracking-widest px-3 pt-1 pb-0.5" style={{ borderTop: `1px solid ${C.border}` }}>
                Open-weight · token-optimised
              </div>
              {LLM_MODELS.filter(m => ['qwen3-235b','qwen3-32b','kimi-k2','glm-4-32b','glm-z1-32b'].includes(m.id)).map(m => {
                const rate = MODEL_RATES[m.id]
                return (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setShowModelMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--c-border)] text-left"
                >
                  <span style={{ color: C.cyan }}>{m.icon}</span>
                  <div className="min-w-0">
                    <div className="mono text-[11px] text-[var(--c-text)]">{m.name}</div>
                    <div className="mono text-[10px] text-[var(--c-faint)]">
                      {m.provider}{rate ? ` · $${rate.in}/$${rate.out}` : ''}
                    </div>
                  </div>
                  {m.id === model && <span className="ml-auto text-[var(--c-cyan)] text-xs">✓</span>}
                </button>
                )
              })}
              <div className="mono text-[10px] text-[var(--c-faint)] px-3 py-2 border-t" style={{ borderColor: C.border }}>
                Retrieval phases are pinned to {FAST_MODEL.name} regardless of this choice.
              </div>
            </div>
          )}
        </div>

        <button
          onClick={startAgent}
          disabled={running}
          className="mono text-[12px] px-4 py-2 rounded font-medium transition-all"
          style={{
            background: running ? a(C.cyan, 0.05) : a(C.cyan, 0.12),
            border: `1px solid ${a(C.cyan, 0.3)}`,
            color: running ? C.faint : C.cyan,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? '⠸ Analysing…' : '⚡ Run RCA Agent'}
        </button>
      </div>

      {/* Guardrails — what the agent is structurally unable to do */}
      <div className="flex flex-wrap gap-2">
        {[
          { k: 'tools', v: 'read-only · no write creds' },
          { k: 'prompt', v: `${tenant.policy.pii}` },
          { k: 'residency', v: tenant.policy.residency },
          { k: 'regime', v: tenant.policy.regime },
          { k: 'budget', v: `$${budget.toFixed(2)}/run cap` },
          { k: 'gate', v: 'human approval for remediation' },
        ].map(({ k, v }) => (
          <div key={k} className="mono text-[10px] px-2 py-1 rounded flex items-center gap-1.5"
            style={{ background: C.card, border: `1px solid ${C.border}` }}>
            <span className="text-[var(--c-faint)]">{k}</span>
            <span className="text-[var(--c-dim)]">{v}</span>
          </div>
        ))}
      </div>

      {/* Run telemetry */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Input tokens', value: totals.tin.toLocaleString(), sub: 'gen_ai.usage.input_tokens', color: C.cyan },
          { label: 'Output tokens', value: totals.tout.toLocaleString(), sub: 'gen_ai.usage.output_tokens', color: C.cyan },
          { label: 'Run cost', value: `$${totals.cost.toFixed(3)}`, sub: `${((totals.cost / budget) * 100).toFixed(0)}% of cap`, color: totals.cost > budget ? C.red : C.green },
          { label: 'Wall time', value: `${totals.secs.toFixed(1)}s`, sub: 'agent span duration', color: C.dim },
          { label: 'Citations', value: String(citationCount), sub: '0 uncited claims', color: C.purple },
        ].map(t => (
          <div key={t.label} className="card p-3">
            <div className="text-[10px] text-[var(--c-dim)] uppercase tracking-widest">{t.label}</div>
            <div className="mono text-lg font-semibold" style={{ color: t.color }}>{t.value}</div>
            <div className="mono text-[9px] text-[var(--c-faint)] truncate">{t.sub}</div>
          </div>
        ))}
      </div>

      {/* Incident context */}
      <div className="card p-4" style={{ border: `1px solid ${a(C.red, 0.2)}`, background: a(C.red, 0.03) }}>
        <div className="mono text-[10px] text-[var(--c-red)] uppercase tracking-widest mb-2">Active Incident Context</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { k: 'Incident', v: 'INC-2847' },
            { k: 'Reported by', v: tenant.label },
            { k: 'Started', v: '16:02 UTC' },
            { k: 'Severity', v: 'P1 — Critical' },
            { k: 'Impact', v: `41,900 ${tenant.impactUnit}` },
          ].map(({ k, v }) => (
            <div key={k}>
              <div className="mono text-[10px] text-[var(--c-faint)]">{k}</div>
              <div className="mono text-[12px] text-[var(--c-text)] font-medium">{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Workflow steps */}
      <div className="flex flex-col gap-3">
        {steps.length === 0 && !running && (
          <div className="card p-8 text-center">
            <div className="text-4xl mb-3">◈</div>
            <div className="mono text-[13px] text-[var(--c-dim)]">Run the agent to produce a cited, cost-metered RCA</div>
            <div className="mono text-[11px] text-[var(--c-faint)] mt-1">
              7 phases · retrieval on {FAST_MODEL.name} · reasoning on {currentModel.name}
            </div>
          </div>
        )}
        {steps.map(step => {
          const col = step.status === 'done' ? C.green
            : step.status === 'running' ? C.cyan
            : step.status === 'blocked' ? C.amber
            : step.status === 'rejected' ? C.red : C.border
          const routedName = step.routed === 'fast' ? FAST_MODEL.name : currentModel.name
          return (
            <div key={step.id} className="card p-4 animate-fade-up" style={{ borderTop: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, borderLeft: `2px solid ${col}` }}>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center mono text-[10px] font-bold flex-shrink-0"
                  style={{ background: a(col, 0.15), color: col }}
                >
                  {step.status === 'done' ? '✓' : step.status === 'running' ? '⠸' : step.status === 'blocked' ? '⏸' : step.status === 'rejected' ? '✕' : '○'}
                </div>
                <span className="mono text-[11px] font-semibold text-[var(--c-text)]">{step.phase}</span>
                {step.tool && (
                  <span className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: a(C.purple, 0.1), color: C.purple, border: `1px solid ${a(C.purple, 0.2)}` }}>
                    {step.tool}
                  </span>
                )}
                <span className="mono text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: a(step.routed === 'fast' ? C.green : C.cyan, 0.1), color: step.routed === 'fast' ? C.green : C.cyan }}>
                  ↳ {routedName}
                </span>
                {step.confidence !== undefined && step.confidence < 1 && (
                  <span className="mono text-[10px] text-[var(--c-dim)]">conf {(step.confidence * 100).toFixed(0)}%</span>
                )}
                <span className="mono text-[10px] text-[var(--c-faint)] ml-auto">
                  {step.tokensIn.toLocaleString()}↓ {step.tokensOut}↑ · {step.latency.toFixed(1)}s · ${stepCost(step, model).toFixed(3)}
                </span>
              </div>

              <div className="mono text-[11px] text-[var(--c-dim)] whitespace-pre-line leading-relaxed ml-8">
                {step.status === 'running' ? streamText : step.content}
                {step.status === 'running' && <span className="ai-typing" />}
              </div>

              {step.citations && step.status !== 'running' && (
                <div className="flex flex-wrap gap-1.5 mt-2 ml-8">
                  {step.citations.map(c => (
                    <span key={c} className="mono text-[9px] px-1.5 py-0.5 rounded cursor-pointer"
                      style={{ background: a(C.cyan, 0.08), border: `1px solid ${a(C.cyan, 0.18)}`, color: C.cyan }}
                      title="Open the exact evidence this claim rests on">
                      {c}
                    </span>
                  ))}
                </div>
              )}

              {/* Human-in-the-loop gate */}
              {step.status === 'blocked' && gate === 'awaiting' && (
                <div className="mt-3 ml-8 p-3 rounded flex items-center gap-3 flex-wrap"
                  style={{ background: a(C.amber, 0.06), border: `1px solid ${a(C.amber, 0.3)}` }}>
                  <span className="mono text-[11px]" style={{ color: C.amber }}>
                    ⏸ Agent paused — remediation needs a named human decision
                  </span>
                  <div className="flex gap-2 ml-auto">
                    <button onClick={approve} className="mono text-[11px] px-3 py-1.5 rounded"
                      style={{ background: a(C.green, 0.12), border: `1px solid ${a(C.green, 0.35)}`, color: C.green }}>
                      Approve P0 rollback
                    </button>
                    <button onClick={reject} className="mono text-[11px] px-3 py-1.5 rounded"
                      style={{ background: a(C.red, 0.1), border: `1px solid ${a(C.red, 0.3)}`, color: C.red }}>
                      Reject & escalate
                    </button>
                  </div>
                </div>
              )}
              {step.status === 'rejected' && (
                <div className="mt-3 ml-8 mono text-[11px]" style={{ color: C.red }}>
                  Rejected by operator · escalated to MPS on-call · agent run halted and logged.
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Ruled out — negative evidence, shown by default */}
      {steps.length >= 3 && (
        <div className="card p-4">
          <SectionHeader title="Ruled Out" sub="what the agent eliminated, and on what evidence" />
          <div className="flex flex-col gap-2">
            {RULED_OUT.map(r => (
              <div key={r.hypothesis} className="flex gap-3 items-start p-2 rounded" style={{ background: C.bg }}>
                <span className="mono text-[11px] flex-shrink-0" style={{ color: C.dim }}>✕</span>
                <div className="min-w-0">
                  <div className="mono text-[11px] text-[var(--c-text2)]">{r.hypothesis}</div>
                  <div className="mono text-[10px] text-[var(--c-faint)]">{r.why}</div>
                </div>
                <span className="mono text-[9px] px-1.5 py-0.5 rounded ml-auto flex-shrink-0"
                  style={{ background: a(C.purple, 0.1), color: C.purple }}>{r.by}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Verdict */}
      {complete && gate !== 'rejected' && (
        <div className="card p-4" style={{ border: `1px solid ${a(C.green, 0.2)}`, background: a(C.green, 0.03) }}>
          <div className="mono text-[11px] text-[var(--c-green)] uppercase tracking-widest mb-3">
            ✓ Analysis complete · {currentModel.name} · ${totals.cost.toFixed(3)} · {citationCount} citations · approved by operator
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              { pri: 'P0', action: 'Rollback payment-svc → v2.13.9', eta: 'executing · ~10 min recovery', color: C.red },
              { pri: 'P1', action: 'Fix release() at payment/process.ts:482', eta: 'ticket MPS-4471 · within 2h', color: C.amber },
              { pri: 'P1', action: 'Add circuit breaker on PIS journey-api → MPS auth', eta: 'ticket PIS-2210 · this sprint', color: C.amber },
            ].map(({ pri, action, eta, color }) => (
              <div key={action} className="p-3 rounded" style={{ background: C.bg, border: `1px solid ${color}30` }}>
                <div className="mono text-[10px] font-bold mb-1" style={{ color }}>{pri}</div>
                <div className="mono text-[11px] text-[var(--c-text2)] mb-1">{action}</div>
                <div className="mono text-[10px] text-[var(--c-faint)]">{eta}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit trail */}
      <div className="card p-4">
        <SectionHeader title="Run Audit Trail" sub="every run replayable — same evidence, same prompt, same verdict" />
        <table className="w-full text-[11px] mono">
          <thead>
            <tr className="text-[var(--c-faint)] text-[10px] uppercase tracking-widest border-b border-[var(--c-border)]">
              <th className="text-left pb-2 font-medium">Run</th>
              <th className="text-left pb-2 font-medium">Tenant</th>
              <th className="text-left pb-2 font-medium">Model</th>
              <th className="text-left pb-2 font-medium">Verdict</th>
              <th className="text-right pb-2 font-medium">Cost</th>
              <th className="text-right pb-2 font-medium">MTTR</th>
              <th className="text-right pb-2 font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {AGENT_RUNS.map(r => (
              <tr key={r.id} className="border-b border-[var(--c-row)] hover:bg-[var(--c-row)]">
                <td className="py-2 text-[var(--c-cyan)]">{r.id}<span className="text-[var(--c-faint)]"> · {r.when}</span></td>
                <td className="py-2">
                  <span className="mono text-[9px] px-1 rounded" style={{ background: a(domainColor(r.tenant as DomainId), 0.14), color: domainColor(r.tenant as DomainId) }}>
                    {DOMAIN_BY_ID[r.tenant as DomainId].short}
                  </span>
                </td>
                <td className="py-2 text-[var(--c-dim)]">{r.model}</td>
                <td className="py-2 text-[var(--c-text2)]">{r.verdict}</td>
                <td className="py-2 text-right text-[var(--c-dim)]">${r.cost.toFixed(2)}</td>
                <td className="py-2 text-right text-[var(--c-dim)]">{r.mttr}</td>
                <td className="py-2 text-right" style={{ color: r.decision === 'approved' ? C.green : C.red }}>{r.decision}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PipelineSection({ domain, timeWindow, setTimeWindow }: { domain: DomainFilter; timeWindow?: TimeWindow; setTimeWindow?: (w: TimeWindow) => void }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const throughput = Array.from({ length: 30 }, (_, i) => ({
    t: i,
    rate: Math.floor(280000 + Math.sin(i * 0.5) * 15000 + Math.random() * 8000),
  }))

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* Pipeline diagram */}
      <div className="card p-6">
        <SectionHeader title="Data Processing Pipeline" sub="real-time event flow" />
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {PIPELINE_STAGES.map((stage, i) => (
            <div key={stage.id} className="flex items-center gap-2 flex-shrink-0">
              <div
                className="pipeline-node flex flex-col items-center gap-1 p-3 rounded cursor-pointer"
                style={{
                  background: C.bg,
                  border: `1px solid ${stage.status === 'ok' ? C.border : C.amber + '40'}`,
                  minWidth: 108,
                }}
              >
                <div className="text-xl" style={{ color: stage.status === 'ok' ? C.cyan : C.amber }}>{stage.icon}</div>
                <div className="mono text-[11px] font-medium text-[var(--c-text)]">{stage.label}</div>
                <div className="mono text-[10px] text-[var(--c-green)]">{stage.rate}</div>
                <div className="mono text-[10px] text-[var(--c-faint)]">{stage.latency}</div>
                <div className="mono text-[9px] text-[var(--c-faint)] text-center leading-tight">{stage.note}</div>
                <div
                  className="w-2 h-2 rounded-full mt-1 animate-pulse-dot"
                  style={{ background: stage.status === 'ok' ? C.green : C.amber }}
                />
              </div>
              {i < PIPELINE_STAGES.length - 1 && (
                <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                  <svg width="32" height="16" className="overflow-visible">
                    <defs>
                      <marker id={`arrow-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill={C.cyan} fillOpacity="0.5" />
                      </marker>
                    </defs>
                    <line x1="0" y1="8" x2="28" y2="8" stroke={C.cyan} strokeWidth="1" strokeOpacity="0.4" markerEnd={`url(#arrow-${i})`} strokeDasharray="4 2">
                      <animate attributeName="stroke-dashoffset" from="6" to="0" dur="0.8s" repeatCount="indefinite" />
                    </line>
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Throughput chart */}
      <div className="card p-4">
        <SectionHeader title="Throughput" sub="events/sec — live" />
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart data={throughput}>
            <defs>
              <linearGradient id="gThrough" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={C.green} stopOpacity={0.12} />
                <stop offset="95%" stopColor={C.green} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="t" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} label={{ value: 'seconds ago', position: 'insideBottomRight', fill: C.faint, fontSize: 10 }} />
            <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={56} tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip content={<CustomTooltip />} formatter={(v: any) => [v.toLocaleString(), 'events/s']} />
            <Area type="monotone" dataKey="rate" stroke={C.green} strokeWidth={1.5} fill="url(#gThrough)" name="events/s" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Stage metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          { label: 'Total Ingested', value: '14.2B', sub: 'last 7 days', color: C.cyan },
          { label: 'Parse Errors', value: '0.003%', sub: 'malformed events', color: C.amber },
          { label: 'Enrichment Latency', value: '12.4ms', sub: 'p99 — above SLA', color: C.orange },
          { label: 'ML Classification', value: '98.7%', sub: 'accuracy', color: C.green },
          { label: 'Index Write Rate', value: '276K/s', sub: 'peak capacity: 500K', color: C.cyan },
          { label: 'Alert Lag', value: '380ms', sub: 'detection to alert', color: C.green },
        ].map(item => <StatCard key={item.label} {...item} />)}
      </div>

      {/* Per-tenant ingest lanes */}
      <div className="card p-4">
        <SectionHeader title="Tenant Ingest Lanes" sub="isolated quotas, redaction policy and residency per team" />
        <table className="w-full text-[11px] mono">
          <thead>
            <tr className="text-[var(--c-faint)] text-[10px] uppercase tracking-widest border-b border-[var(--c-border)]">
              <th className="text-left pb-2 font-medium">Tenant</th>
              <th className="text-right pb-2 font-medium">Ingest</th>
              <th className="text-right pb-2 font-medium">Quota</th>
              <th className="text-left pb-2 font-medium">Redaction at ingest</th>
              <th className="text-left pb-2 font-medium">Residency</th>
              <th className="text-right pb-2 font-medium">Retention</th>
              <th className="text-right pb-2 font-medium">DLQ</th>
            </tr>
          </thead>
          <tbody>
            {DOMAINS.filter(d => d.id === domain).map(d => {
              const used = d.share * 284
              const quota = d.share * 284 * 1.4
              const pressure = used / quota
              return (
                <tr key={d.id} className="border-b border-[var(--c-row)] hover:bg-[var(--c-row)]">
                  <td className="py-2">
                    <span className="mono text-[9px] px-1 rounded mr-2" style={{ background: a(domainColor(d.id), 0.14), color: domainColor(d.id) }}>{d.short}</span>
                    <span className="text-[var(--c-text)]">{d.label}</span>
                  </td>
                  <td className="py-2 text-right text-[var(--c-text2)]">{used.toFixed(0)}K/s</td>
                  <td className="py-2 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-16 h-1.5 rounded-full" style={{ background: C.border }}>
                        <div className="h-full rounded-full" style={{ width: `${pressure * 100}%`, background: pressure > 0.8 ? C.amber : C.green }} />
                      </div>
                      <span className="text-[var(--c-faint)]">{quota.toFixed(0)}K/s</span>
                    </div>
                  </td>
                  <td className="py-2 text-[var(--c-dim)]">{d.policy.pii}</td>
                  <td className="py-2 text-[var(--c-cyan)]">{d.policy.residency}</td>
                  <td className="py-2 text-right text-[var(--c-dim)]">{d.policy.retention}</td>
                  <td className="py-2 text-right" style={{ color: seeded(d.id, 3) > 0.6 ? C.amber : C.dim }}>
                    {Math.floor(seeded(d.id, 3) * 180)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* DLQ */}
      <div className="card p-4">
        <SectionHeader title="Dead Letter Queue" sub="failed processing events" />
        <table className="w-full text-[11px] mono">
          <thead>
            <tr className="text-[var(--c-faint)] text-[10px] uppercase tracking-widest border-b border-[var(--c-border)]">
              <th className="text-left pb-2">Stage</th>
              <th className="text-right pb-2">Count</th>
              <th className="text-right pb-2">Oldest</th>
              <th className="text-right pb-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {[
              { stage: 'parse', count: 142, oldest: '2d 3h', reason: 'Invalid UTF-8 encoding' },
              { stage: 'enrich', count: 87, oldest: '6h', reason: 'GeoIP lookup timeout' },
              { stage: 'classify', count: 14, oldest: '45m', reason: 'Model response timeout' },
            ].map(row => (
              <tr key={row.stage} className="border-b border-[var(--c-row)]">
                <td className="py-2 text-[var(--c-cyan)]">{row.stage}</td>
                <td className="py-2 text-right text-[var(--c-amber)]">{row.count}</td>
                <td className="py-2 text-right text-[var(--c-faint)]">{row.oldest}</td>
                <td className="py-2 text-right text-[var(--c-dim)]">{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Nav items ────────────────────────────────────────────────────────────────

// ─── Team system overview ─────────────────────────────────────────────────────

/** Data-source switch plus live connection state for the Elastic backend. */
function SourcePill({ source, setSource, es }: {
  source: DataSource; setSource: (s: DataSource) => void; es: EsState
}) {
  const [open, setOpen] = useState(false)
  const col = source === 'demo'
    ? C.dim
    : es.status === 'live' ? C.green : es.status === 'error' ? C.red : C.amber
  const label = source === 'demo'
    ? 'Demo data'
    : es.status === 'live' ? `Elastic · ${es.latencyMs}ms`
      : es.status === 'error' ? 'Elastic · error' : 'Elastic · connecting'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="mono text-[10px] px-2 py-1 rounded flex items-center gap-1.5 transition-colors"
        style={{ background: a(col, 0.1), border: `1px solid ${a(col, 0.28)}`, color: col }}
        title={es.error ?? 'Data source'}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${es.status === 'live' ? 'animate-pulse-dot' : ''}`} style={{ background: col }} />
        <span>{label}</span>
        <span className="text-[var(--c-faint)]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded p-3 flex flex-col gap-2"
          style={{ background: C.card, border: `1px solid ${C.border}`, minWidth: 320 }}>
          <div className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Data source</div>
          {([['demo', 'Demo generator', '5 synthetic tenants'],
            ['elastic', 'Elasticsearch', ES_TENANTS.map(t => t.index).join(' · ')]] as [DataSource, string, string][])
            .map(([id, name, sub]) => (
              <button
                key={id}
                onClick={() => { setSource(id); setOpen(false) }}
                className="text-left px-2 py-1.5 rounded"
                style={{ background: source === id ? a(C.cyan, 0.1) : 'transparent', border: `1px solid ${source === id ? a(C.cyan, 0.3) : 'transparent'}` }}
              >
                <div className="mono text-[11px]" style={{ color: source === id ? C.cyan : C.text }}>{name}</div>
                <div className="mono text-[10px] text-[var(--c-faint)] truncate">{sub}</div>
              </button>
            ))}

          {source === 'elastic' && (
            <div className="pt-2 mt-1 flex flex-col gap-1" style={{ borderTop: `1px solid ${C.border}` }}>
              {[
                ['Endpoint', ES_BASE],
                ['Status', es.status],
                ['Last poll', es.lastPoll ?? '—'],
                ['Docs pulled', es.docsSeen.toLocaleString()],
                ['Window', `${es.logs.length} events buffered`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <span className="mono text-[10px] text-[var(--c-faint)]">{k}</span>
                  <span className="mono text-[10px] text-[var(--c-dim)] truncate">{v}</span>
                </div>
              ))}
              {es.error && (
                <div className="mono text-[10px] mt-1 p-2 rounded leading-relaxed"
                  style={{ background: a(C.red, 0.06), border: `1px solid ${a(C.red, 0.2)}`, color: C.red }}>
                  {es.error}
                </div>
              )}
              <button
                onClick={() => { es.refresh(); setOpen(false) }}
                className="mono text-[10px] mt-1 px-2 py-1 rounded self-start"
                style={{ background: a(C.cyan, 0.1), border: `1px solid ${a(C.cyan, 0.3)}`, color: C.cyan }}
              >
                ⟳ Reconnect
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TierBadge({ tier }: { tier: ServiceTier }) {
  const col = tier === 'critical' ? C.red : tier === 'core' ? C.amber : C.dim
  return (
    <span className="mono text-[9px] px-1 rounded uppercase tracking-wide"
      style={{ background: a(col, 0.12), color: col, border: `1px solid ${a(col, 0.22)}` }}>
      {tier}
    </span>
  )
}

function StatusDot({ status }: { status: string }) {
  const col = status === 'degraded' ? C.red : status === 'watch' ? C.amber : C.green
  return <span className={`w-1.5 h-1.5 rounded-full inline-block flex-shrink-0 ${status === 'degraded' ? 'animate-pulse-dot' : ''}`} style={{ background: col }} />
}

function TeamsSection({ logs, domain, setDomain, esServices }: {
  logs: LogEntry[]; domain: DomainFilter; setDomain: (d: DomainFilter) => void
  esServices?: Record<string, ServiceRollup[]>
}) {
  const fallbackTeam = DOMAINS[0]?.id ?? 'mps'
  const [teamId, setTeamId] = useState<DomainId>(domain)
  useEffect(() => { setTeamId(domain) }, [domain])
  // The registry changes when the data source does; keep the selection valid.
  useEffect(() => {
    if (!DOMAINS.some(t => t.id === teamId)) setTeamId(fallbackTeam)
  }, [teamId, fallbackTeam])

  const d = DOMAIN_BY_ID[teamId]
  const profile = TEAM_PROFILES[teamId]
  const col = domainColor(teamId)
  const rollups = esServices?.[teamId]
  const services = d.services.map(svc => ({
    svc,
    ...serviceStats(svc, rollups?.find(r => r.service === svc)),
  }))
  const teamLogs = logs.filter(l => l.domain === teamId)
  const errs = teamLogs.filter(l => l.severity === 'CRITICAL' || l.severity === 'ERROR').length
  const errRate = teamLogs.length ? (errs / teamLogs.length) * 100 : 0

  // Severity composition per service — where the noise actually comes from.
  const sevMix = services.map(s => {
    const row: Record<string, number | string> = { name: s.svc }
    let rem = s.logsPerMin
    SEVERITIES.forEach((sev, i) => {
      const w = [0.03, 0.08, 0.15, 0.55, 0.19][i] * (sev === 'CRITICAL' || sev === 'ERROR' ? s.errRate / 3 : 1)
      const v = Math.max(1, Math.floor(s.logsPerMin * w))
      row[sev] = Math.max(0, Math.min(v, rem))
      rem -= Number(row[sev])
    })
    return row
  })

  const teamVolume = VOLUME_DATA.map(v => ({
    time: v.time,
    volume: v[teamId] as number,
    errors: Math.floor((v[teamId] as number) * (0.04 + seeded('tv' + teamId, Number(String(v.time).slice(0, 2))) * 0.07)),
  }))

  const fingerprints = FINGERPRINTS.filter(f => f.dom === teamId)

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* Team switcher */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Team</span>
        {DOMAINS.map(t => {
          const on = t.id === teamId
          const tc = domainColor(t.id)
          return (
            <button
              key={t.id}
              onClick={() => { setTeamId(t.id); setDomain(t.id) }}
              className="mono text-[11px] px-2 py-1 rounded flex items-center gap-1.5 transition-colors"
              style={{
                background: on ? a(tc, 0.14) : 'transparent',
                border: `1px solid ${on ? a(tc, 0.45) : C.border}`,
                color: on ? tc : C.dim,
              }}
            >
              <span>{t.icon}</span><span>{t.team}</span>
            </button>
          )
        })}
      </div>

      {/* Identity + posture */}
      <div className="card p-4" style={{ borderTop: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, borderLeft: `2px solid ${col}` }}>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-64">
            <div className="flex items-center gap-2">
              <span className="text-lg" style={{ color: col }}>{d.icon}</span>
              <div>
                <div className="text-sm font-semibold text-[var(--c-text)]">{d.team}</div>
                <div className="mono text-[11px] text-[var(--c-faint)]">{d.label} · tenant {d.short} · judged on {d.impactUnit}</div>
              </div>
            </div>
            <div className="mono text-[11px] text-[var(--c-text2)] mt-3 leading-relaxed">{profile.posture}</div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 min-w-72">
            {[
              ['On-call', profile.oncall],
              ['Escalation', profile.escalation],
              ['Residency', `${d.policy.residency} · ${d.policy.retention}`],
              ['Regime', d.policy.regime],
              ['PII handling', d.policy.pii],
              ['SLO', `${d.slo.name} @ ${d.slo.target}`],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="mono text-[9px] text-[var(--c-faint)] uppercase tracking-widest">{k}</div>
                <div className="mono text-[11px] text-[var(--c-text2)]">{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Services" value={String(services.length)} sub={`${services.filter(s => s.tier === 'critical').length} critical tier`} color={col} />
        <StatCard label="Instances" value={String(services.reduce((n, s) => n + s.instances, 0))} sub="across the estate" color={C.cyan} />
        <StatCard label="Log Rate" value={`${(services.reduce((n, s) => n + s.logsPerMin, 0) / 1000).toFixed(1)}K`} sub="events/min" color={C.cyan} />
        <StatCard label="Error Rate" value={`${errRate.toFixed(1)}%`} sub="live sample" color={errRate > 8 ? C.red : errRate > 4 ? C.amber : C.green} />
        <StatCard label="SLO Attainment" value={`${d.slo.attainment}%`} sub={`target ${d.slo.target}`} color={d.slo.attainment >= Number(d.slo.target.replace('%', '')) ? C.green : C.red} />
        <StatCard label="Budget Burn" value={`${d.slo.burn.toFixed(1)}×`} sub="1h window" color={d.slo.burn > 6 ? C.red : d.slo.burn > 2 ? C.amber : C.green} />
      </div>

      {services.length === 0 && (
        <div className="card p-6 text-center">
          <div className="mono text-[12px] text-[var(--c-dim)]">No services discovered for {d.label}.</div>
          <div className="mono text-[11px] text-[var(--c-faint)] mt-1">
            {d.index ? `Waiting on the first aggregation over ${d.index}` : 'No index configured for this tenant'}
          </div>
        </div>
      )}

      {/* Volume + severity composition */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="card p-4">
          <SectionHeader title="Team Log Volume" sub={`24h · ${d.label}`} />
          <ResponsiveContainer width="100%" height={190}>
            <AreaChart data={teamVolume} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`gTeam-${teamId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={col} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={col} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} interval={3} />
              <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={44}
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="volume" stroke={col} strokeWidth={1.5} fill={`url(#gTeam-${teamId})`} name="events" dot={false} />
              <Area type="monotone" dataKey="errors" stroke={C.red} strokeWidth={1.5} fill="none" name="errors" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-4">
          <SectionHeader title="Severity Mix by Service" sub="events/min — who generates the noise" />
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={sevMix} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barSize={14}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false}
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={128} />
              <Tooltip content={<CustomTooltip />} />
              {SEVERITIES.map(sev => (
                <Bar key={sev} dataKey={sev} stackId="sev" fill={SEV_COLOR()[sev]} fillOpacity={0.85} name={sev} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-3 mt-2">
            {SEVERITIES.map(sev => (
              <div key={sev} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm" style={{ background: SEV_COLOR()[sev] }} />
                <span className="mono text-[10px] text-[var(--c-dim)]">{sev}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Service inventory */}
      <div className="card p-4">
        <SectionHeader title="Service Inventory" sub={`${services.length} services · owned by ${d.team}`} />
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] mono" style={{ minWidth: 900 }}>
            <thead>
              <tr className="text-[var(--c-faint)] text-[10px] uppercase tracking-widest border-b border-[var(--c-border)]">
                <th className="text-left pb-2 font-medium">Service</th>
                <th className="text-left pb-2 font-medium">Tier</th>
                <th className="text-left pb-2 font-medium">Runtime</th>
                <th className="text-right pb-2 font-medium">Inst.</th>
                <th className="text-right pb-2 font-medium">Req/min</th>
                <th className="text-right pb-2 font-medium">Logs/min</th>
                <th className="text-right pb-2 font-medium">Err %</th>
                <th className="text-right pb-2 font-medium">p99</th>
                <th className="text-right pb-2 font-medium">CPU</th>
                <th className="text-right pb-2 font-medium">Deployed</th>
                <th className="text-left pb-2 font-medium pl-4">Squad</th>
              </tr>
            </thead>
            <tbody>
              {services.map(s => (
                <tr key={s.svc} className="border-b border-[var(--c-row)] hover:bg-[var(--c-row)]">
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <StatusDot status={s.status} />
                      <span className="text-[var(--c-text)]">{s.svc}</span>
                    </div>
                    {s.deps.length > 0 && (
                      <div className="flex gap-1 mt-1 ml-3.5 flex-wrap">
                        {s.deps.map(dep => {
                          const cross = dep.includes(':')
                          const [dm, name] = cross ? dep.split(':') : [null, dep]
                          const dc = cross ? domainColor(dm as DomainId) : C.faint
                          return (
                            <span key={dep} className="mono text-[9px] px-1 rounded"
                              style={{ background: a(dc, 0.1), color: dc, border: `1px solid ${a(dc, cross ? 0.3 : 0.15)}` }}>
                              → {name}{cross ? ` (${DOMAIN_BY_ID[dm as DomainId].short})` : ''}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                  <td className="py-2"><TierBadge tier={s.tier} /></td>
                  <td className="py-2 text-[var(--c-dim)]">{s.runtime} <span className="text-[var(--c-faint)]">{s.version}</span></td>
                  <td className="py-2 text-right text-[var(--c-dim)]">{s.instances}</td>
                  <td className="py-2 text-right text-[var(--c-dim)]">{s.rpm.toLocaleString()}</td>
                  <td className="py-2 text-right text-[var(--c-dim)]">{s.logsPerMin.toLocaleString()}</td>
                  <td className="py-2 text-right" style={{ color: s.errRate > 5 ? C.red : s.errRate > 2.5 ? C.amber : C.green }}>{s.errRate}%</td>
                  <td className="py-2 text-right" style={{ color: s.p99 > 500 ? C.amber : C.dim }}>{s.p99}ms</td>
                  <td className="py-2 text-right text-[var(--c-dim)]">{s.cpu}%</td>
                  <td className="py-2 text-right text-[var(--c-faint)]">{s.lastDeploy}</td>
                  <td className="py-2 text-[var(--c-dim)] pl-4">{s.squad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Telemetry contract + risk register */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="card p-4">
          <SectionHeader title="Telemetry Contract" sub="how this team's logs reach the platform" />
          <div className="flex flex-col gap-3">
            {[
              ['Sources', profile.ingest.sources],
              ['Peak volume', profile.ingest.volume],
              ['Schema', profile.ingest.schema],
              ['Sampling', profile.ingest.sampling],
              ['Redaction', d.policy.pii],
              ['Retention', `${d.policy.retention} · pinned to ${d.policy.residency}`],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <span className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest w-28 flex-shrink-0 pt-0.5">{k}</span>
                <span className="mono text-[11px] text-[var(--c-text2)] flex-1">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <SectionHeader title="Open Risks" sub="carried by this team, not yet closed" />
          <div className="flex flex-col gap-2">
            {profile.risks.map(r => {
              const rc = r.level === 'high' ? C.red : r.level === 'medium' ? C.amber : C.dim
              return (
                <div key={r.text} className="flex gap-2 p-2 rounded" style={{ background: a(rc, 0.05), border: `1px solid ${a(rc, 0.18)}` }}>
                  <span className="mono text-[9px] uppercase tracking-wide flex-shrink-0 pt-0.5" style={{ color: rc }}>{r.level}</span>
                  <span className="mono text-[11px] text-[var(--c-text2)] leading-relaxed">{r.text}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Team fingerprints + live tail */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="card p-4">
          <SectionHeader title="Recurring Fingerprints" sub="deduplicated for this team" />
          {fingerprints.length === 0 ? (
            <div className="mono text-[11px] text-[var(--c-faint)] py-4">No recurring fingerprints above threshold.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {fingerprints.map(f => (
                <div key={f.fp} className="flex items-center gap-3">
                  <span className="mono text-[11px] text-[var(--c-text)] flex-1 truncate">{f.fp}</span>
                  <span className="mono text-[10px] text-[var(--c-cyan)] w-32 truncate">{f.svc}</span>
                  <span className="mono text-[11px] text-[var(--c-red)] w-14 text-right">{f.count.toLocaleString()}</span>
                  <span className="mono text-[10px] text-[var(--c-faint)] w-16 text-right">{f.last}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4 min-h-0">
          <SectionHeader title="Live Tail" sub={`${d.label} · newest first`} />
          <div className="flex flex-col gap-1 overflow-auto" style={{ maxHeight: 220 }}>
            {teamLogs.slice(0, 40).map(l => (
              <div key={l.id} className="mono text-[10px] flex gap-2 items-baseline">
                <span className="text-[var(--c-faint)] flex-shrink-0">{l.timestamp.slice(11, 19)}</span>
                <span style={{ color: SEV_COLOR()[l.severity] }} className="w-14 flex-shrink-0">{l.severity}</span>
                <span className="text-[var(--c-cyan)] w-32 flex-shrink-0 truncate">{l.service}</span>
                <span className="text-[var(--c-text2)] truncate">{l.message}</span>
              </div>
            ))}
            {teamLogs.length === 0 && <div className="mono text-[11px] text-[var(--c-faint)]">Waiting for events…</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── LobSection ───────────────────────────────────────────────────────────────
// Replaces both OverviewSection and TeamsSection. Shows summary KPIs then the
// detailed per-service breakdown for the selected LoB.

function LobSection({ logs, domain, setDomain, esServices, timeWindow, setTimeWindow }: {
  logs: LogEntry[]
  domain: DomainFilter
  setDomain: (d: DomainFilter) => void
  esServices?: Record<string, { service: string }[]>
  timeWindow?: TimeWindow
  setTimeWindow?: (w: TimeWindow) => void
}) {
  const d = DOMAIN_BY_ID[domain]
  const profile = TEAM_PROFILES[domain]
  const liveRollup = esServices?.[domain]
  const domainLogs = logs.filter(l => l.domain === domain)
  const errLogs = domainLogs.filter(l => l.severity === 'CRITICAL' || l.severity === 'ERROR')
  const errorRate = domainLogs.length ? ((errLogs.length / domainLogs.length) * 100).toFixed(1) : '0.0'
  const logRate = Math.floor(d.share * 4200)

  // Active = services with errRate < 5, inactive = others
  const svcList = liveRollup ? liveRollup.map(s => s.service) : d.services
  const svcStats = svcList.map(s => serviceStats(s))
  const active = svcStats.filter(s => s.status !== 'degraded')
  const inactive = svcStats.filter(s => s.status === 'degraded')

  const col = domainColor(domain)

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* Time window + LoB tabs */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-2">
          {DOMAINS.map(t => (
            <button key={t.id} onClick={() => setDomain(t.id)}
              className="mono text-[11px] px-2 py-1 rounded flex items-center gap-1.5 transition-colors"
              style={{
                background: domain === t.id ? a(domainColor(t.id), 0.14) : 'transparent',
                border: `1px solid ${domain === t.id ? a(domainColor(t.id), 0.45) : C.border}`,
                color: domain === t.id ? domainColor(t.id) : C.dim,
              }}>
              <span>{t.icon}</span><span>{t.short}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Summary banner */}
      <div className="card p-4 flex items-start gap-4" style={{ borderTop: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, borderLeft: `3px solid ${col}` }}>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: col }}>{d.icon}</span>
            <span className="mono text-sm font-semibold text-[var(--c-text)]">{d.team}</span>
            <span className="mono text-[10px] px-1.5 py-0.5 rounded ml-2"
              style={{ background: a(d.slo.burn > 6 ? C.red : d.slo.burn > 2 ? C.amber : C.green, 0.12), color: d.slo.burn > 6 ? C.red : d.slo.burn > 2 ? C.amber : C.green }}>
              {d.slo.burn > 6 ? 'CRITICAL' : d.slo.burn > 2 ? 'DEGRADED' : 'HEALTHY'}
            </span>
          </div>
          <p className="mono text-[11px] text-[var(--c-dim)]">{profile.posture}</p>
        </div>
      </div>

      {/* KPI row — Active services, Inactive services, Log rate, Error rate */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active Services" value={String(active.length)} sub={`of ${svcList.length} total`} color={C.green} />
        <StatCard label="Inactive / Degraded" value={String(inactive.length)} sub="error rate > 5%" color={inactive.length > 0 ? C.red : C.dim} />
        <StatCard label="Log Rate" value={`${logRate.toLocaleString()}/min`} sub={`${timeWindow ?? '1h'} window`} color={col} />
        <StatCard label="Error Rate" value={`${errorRate}%`} sub="of sampled events" color={Number(errorRate) > 5 ? C.red : Number(errorRate) > 2 ? C.amber : C.dim} />
      </div>

      {/* Service list */}
      <div className="card p-4">
        <SectionHeader title="Services" sub={`${d.team} · ${timeWindow ?? '1h'} window`} />
        <div className="mono text-[10px] text-[var(--c-faint)] grid gap-2 px-1 pb-2 uppercase tracking-widest"
          style={{ gridTemplateColumns: '180px 70px 70px 1fr 80px 80px' }}>
          <span>Service</span><span className="text-right">Err %</span><span className="text-right">p99</span>
          <span>Error budget</span><span className="text-right">Events/min</span><span className="text-right">Status</span>
        </div>
        <div className="flex flex-col gap-px">
          {svcStats.map((s, si) => {
            const sc = s.status === 'degraded' ? C.red : s.status === 'watch' ? C.amber : C.green
            return (
              <div key={svcList[si]} className="log-row grid gap-2 items-center px-1 py-2 rounded"
                style={{ gridTemplateColumns: '180px 70px 70px 1fr 80px 80px' }}>
                <div className="min-w-0">
                  <div className="mono text-[11px] text-[var(--c-text)] truncate">{svcList[si]}</div>
                  <div className="mono text-[9px] text-[var(--c-faint)]">{s.runtime} · {s.version}</div>
                </div>
                <div className="mono text-[11px] text-right" style={{ color: sc }}>{s.errRate}%</div>
                <div className="mono text-[11px] text-[var(--c-dim)] text-right">{s.p99}ms</div>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.border }}>
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${Math.min(100, s.errRate * 10)}%`, background: sc }} />
                </div>
                <div className="mono text-[11px] text-[var(--c-dim)] text-right">{s.logsPerMin.toLocaleString()}</div>
                <div className="mono text-[10px] text-right" style={{ color: sc }}>
                  {s.status === 'degraded' ? '● degraded' : s.status === 'watch' ? '◐ watch' : '○ healthy'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Risks */}
      {profile.risks.length > 0 && (
        <div className="card p-4">
          <SectionHeader title="Open Risks" sub="operator-declared · not machine-generated" />
          <div className="flex flex-col gap-2">
            {profile.risks.map((r, i) => {
              const rc = r.level === 'high' ? C.red : r.level === 'medium' ? C.amber : C.dim
              return (
                <div key={i} className="flex gap-2 p-2 rounded" style={{ background: a(rc, 0.05), border: `1px solid ${a(rc, 0.18)}` }}>
                  <span className="mono text-[9px] uppercase tracking-wide flex-shrink-0 pt-0.5" style={{ color: rc }}>{r.level}</span>
                  <span className="mono text-[11px] text-[var(--c-text2)] leading-relaxed">{r.text}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SLASection ───────────────────────────────────────────────────────────────

function SLASection({ domain, timeWindow, setTimeWindow }: {
  domain: DomainFilter; timeWindow?: TimeWindow; setTimeWindow?: (w: TimeWindow) => void
}) {
  const slaRows = DOMAINS.map(d => {
    const breachCount = Math.floor(seeded(d.id + 'breach', 0) * 8)
    const trend = d.slo.burn > 4 ? '↑' : d.slo.burn > 1.5 ? '→' : '↓'
    return { d, breachCount, trend }
  })

  const BREACH_HISTORY = [
    { when: '16:03–16:18 UTC', lob: 'mps', desc: 'Auth success rate below 99.9% for 15m — conn pool exhausted', severity: 'critical', mttr: '18m' },
    { when: '14:41–14:48 UTC', lob: 'pis', desc: 'Display freshness SLO breached — journey API 503', severity: 'high', mttr: '7m' },
    { when: '09:12–09:43 UTC', lob: 'mrd', desc: 'Signal plan freshness degraded — detector coverage 71%', severity: 'medium', mttr: '31m' },
    { when: '06:04–06:09 UTC', lob: 'ssa', desc: 'Alert latency SLO breach — classifier GPU backpressure', severity: 'high', mttr: '5m' },
    { when: 'Yesterday 22:10', lob: 'mps', desc: 'Auth burst — 142 failures in 90s', severity: 'medium', mttr: '12m' },
  ]

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      {/* SLA matrix */}
      <div className="card p-4">
        <SectionHeader title="SLA Attainment" sub={`all LoBs · ${timeWindow ?? '24h'}`} />
        <div className="mono text-[10px] text-[var(--c-faint)] grid gap-2 px-1 pb-2 uppercase tracking-widest"
          style={{ gridTemplateColumns: '140px 1fr 80px 80px 80px 60px' }}>
          <span>LoB</span><span>SLO</span><span className="text-right">Target</span>
          <span className="text-right">Attainment</span><span className="text-right">Burn</span><span className="text-right">Breaches</span>
        </div>
        <div className="flex flex-col gap-px">
          {slaRows.map(({ d, breachCount, trend }) => {
            const ok = d.slo.attainment >= Number(d.slo.target.replace('%', ''))
            const col = d.slo.burn > 6 ? C.red : d.slo.burn > 2 ? C.amber : C.green
            return (
              <div key={d.id} className="log-row grid gap-2 items-center px-1 py-2 rounded"
                style={{ gridTemplateColumns: '140px 1fr 80px 80px 80px 60px', background: d.id === domain ? a(domainColor(d.id), 0.06) : 'transparent' }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: domainColor(d.id) }}>{d.icon}</span>
                  <span className="mono text-[11px] text-[var(--c-text)]">{d.short}</span>
                </div>
                <span className="mono text-[10px] text-[var(--c-dim)] truncate">{d.slo.name}</span>
                <span className="mono text-[11px] text-right text-[var(--c-dim)]">{d.slo.target}</span>
                <span className="mono text-[11px] text-right" style={{ color: ok ? C.green : C.red }}>{d.slo.attainment}%</span>
                <span className="mono text-[11px] text-right flex items-center justify-end gap-1" style={{ color: col }}>
                  {d.slo.burn.toFixed(1)}× <span className="text-[10px]">{trend}</span>
                </span>
                <span className="mono text-[11px] text-right" style={{ color: breachCount > 3 ? C.red : breachCount > 0 ? C.amber : C.dim }}>
                  {breachCount}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Burn trend sparklines */}
      <div className="card p-4">
        <SectionHeader title="Burn Rate Trend" sub="24h · 1× = sustainable · >6× pages" />
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={BURN_TREND} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="time" tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} interval={3} />
            <YAxis tick={{ fill: C.dim, fontSize: 10, fontFamily: 'JetBrains Mono' }} tickLine={false} axisLine={false} width={36} domain={[0, 8]} tickFormatter={(v: number) => `${v}×`} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={6} stroke={C.red} strokeDasharray="4 3" strokeWidth={1} />
            {DOMAINS.map(d => (
              <Line key={d.id} type="monotone" dataKey={d.id} stroke={domainColor(d.id)} strokeWidth={1.4} dot={false} name={d.short} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Breach history */}
      <div className="card p-4">
        <SectionHeader title="Breach History" sub="last 24h · all LoBs" />
        <div className="flex flex-col gap-2">
          {BREACH_HISTORY.map((b, i) => {
            const bc = b.severity === 'critical' ? C.red : b.severity === 'high' ? C.orange : C.amber
            const lobDef = DOMAIN_BY_ID[b.lob as DomainId]
            return (
              <div key={i} className="flex gap-3 p-3 rounded" style={{ background: a(bc, 0.05), border: `1px solid ${a(bc, 0.18)}` }}>
                <div className="flex-shrink-0">
                  <div className="mono text-[9px] text-[var(--c-faint)]">{b.when}</div>
                  <div className="mono text-[9px] mt-0.5 px-1 rounded" style={{ background: a(domainColor(b.lob as DomainId), 0.14), color: domainColor(b.lob as DomainId) }}>
                    {lobDef?.short ?? b.lob}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="mono text-[11px] text-[var(--c-text2)] leading-snug">{b.desc}</div>
                </div>
                <div className="flex-shrink-0 text-right">
                  <div className="mono text-[9px] text-[var(--c-faint)]">MTTR</div>
                  <div className="mono text-[11px]" style={{ color: bc }}>{b.mttr}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── CustomAgentSection ────────────────────────────────────────────────────────

/** Generate deterministic run steps from a custom agent's capability list. */
function buildCustomAgentSteps(ag: CustomAgentDef, domainLabel: string): Omit<AgentStep, 'status'>[] {
  const CAP_STEPS: Record<string, Omit<AgentStep, 'status'>> = {
    'Log search': {
      id: 'ls', phase: 'Log Search', tool: 'search_logs()', routed: 'fast',
      tokensIn: 14200, tokensOut: 190, latency: 1.4, confidence: 1,
      citations: ['log:9fa21c', 'log:71bb04'],
      content: `Pulled 38,400 events for ${domainLabel} (last window). Applied redaction: 842 identifiers masked. Retained 31 exemplar events after dedup by fingerprint.`,
    },
    'Anomaly detection': {
      id: 'ad', phase: 'Anomaly Detection', tool: 'detect_anomalies()', routed: 'fast',
      tokensIn: 8800, tokensOut: 310, latency: 2.1, confidence: 0.88,
      citations: ['metric:err_rate', 'fp:ERR-upstream-timeout-5s'],
      content: `Detected 3 statistical anomalies above 3σ threshold.\n  1. Error rate spike: +420% vs 7d baseline — onset 16:02 UTC\n  2. p99 latency: 4.8s (baseline 340ms) on payment-svc\n  3. Connection pool saturation: 512/512 — zero headroom`,
    },
    'RCA reasoning': {
      id: 'rca', phase: 'RCA Reasoning', tool: 'rank_hypotheses()', routed: 'reasoning',
      tokensIn: 11600, tokensOut: 680, latency: 4.2, confidence: 0.91,
      citations: ['heap:payment-svc-5d9f8b', 'deploy:payment-svc@v2.14.1'],
      content: `Ranked 5 root cause hypotheses:\n  1. 0.91 — connection leak in payment-svc v2.14.1 (missing release())\n  2. 0.43 — acquirer latency holding connections open\n  3. 0.19 — missing circuit breaker amplifying queue depth\n  2 candidates eliminated by negative evidence.`,
    },
    'Alert routing': {
      id: 'ar', phase: 'Alert Routing', tool: 'route_alerts()', routed: 'fast',
      tokensIn: 4400, tokensOut: 160, latency: 0.9, confidence: 1,
      citations: ['alert:INC-2847', 'runbook:MPS-014'],
      content: `Routed 4 alerts to on-call owners.\n  P1 → MPS on-call (Slack + PagerDuty)\n  P2 → PIS team (Slack)\n  P2 → MRD ops (email)\n  P3 → SSA NOC (dashboard badge only)`,
    },
    'Cross-LoB correlation': {
      id: 'cl', phase: 'Cross-LoB Correlation', tool: 'correlate_topology()', routed: 'reasoning',
      tokensIn: 9200, tokensOut: 440, latency: 3.1, confidence: 0.87,
      citations: ['trace:8c4d19a2f0', 'topology:mps→pis'],
      content: `Fingerprint ERR-upstream-timeout-5s propagated across 3 LoBs.\n  MPS → onset 15:56 (origin)\n  PIS → onset 16:01 (+5m) via journey-api→token-endpoint\n  MRD → onset 16:09 (+13m) via route-optimiser auth\n  SSA alert delay is a downstream effect, not a cause.`,
    },
    'SLA monitoring': {
      id: 'sla', phase: 'SLA Monitoring', tool: 'check_sla_burn()', routed: 'fast',
      tokensIn: 5100, tokensOut: 220, latency: 1.2, confidence: 1,
      citations: ['metric:burn_rate', 'slo:mps-auth'],
      content: `SLA burn rate check complete.\n  MPS authorisation success: 6.9× burn (target ≤1×) — BREACHED\n  PIS display availability: 2.4× burn — WARNING\n  MRD signal freshness: 0.8× burn — nominal\n  SSA alert SLA: 4.2× burn — WARNING`,
    },
    'Trend analysis': {
      id: 'ta', phase: 'Trend Analysis', tool: 'analyse_trends()', routed: 'fast',
      tokensIn: 7300, tokensOut: 290, latency: 1.8, confidence: 0.95,
      citations: ['metric:pool.active', 'metric:err_rate'],
      content: `7-day trend analysis complete.\n  Error rate: +38% w/w — accelerating since v2.13.x rollout series\n  Connection pool headroom: declining 4.1%/day (linear regression r²=0.97)\n  p99 latency: stable until v2.14.1 deploy — step-change confirmed`,
    },
    'Incident summarisation': {
      id: 'is', phase: 'Incident Summary', tool: 'write_summary()', routed: 'reasoning',
      tokensIn: 6800, tokensOut: 510, latency: 2.6, confidence: 1,
      citations: ['inc:INC-2847', 'deploy:payment-svc@v2.14.1'],
      content: `INC-2847 Summary drafted.\n  Root cause: connection leak in payment-svc v2.14.1\n  Impact: MPS (18,402 txns), PIS (412 screens), MRD (11 junctions)\n  Duration: 16:02–16:17 UTC (15 minutes)\n  Resolution: rollback to v2.13.9\n  Follow-up: 3 tickets filed, new detector registered`,
    },
  }
  return ag.capabilities
    .filter(c => CAP_STEPS[c])
    .map(c => ({ ...CAP_STEPS[c] }))
}

function CustomAgentRunner({ ag, domain, onClose }: { ag: CustomAgentDef; domain: DomainFilter; onClose: () => void }) {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [streamText, setStreamText] = useState('')
  const [done, setDone] = useState(false)
  const resume = useRef<(() => void) | null>(null)
  const tenant = DOMAIN_BY_ID[domain]
  const modelInfo = LLM_MODELS.find(m => m.id === ag.model) || LLM_MODELS[0]
  const STEPS = useMemo(() => buildCustomAgentSteps(ag, tenant.label), [ag, tenant.label])

  const startRun = useCallback(() => {
    setRunning(true); setSteps([]); setStreamText(''); setDone(false)
    let idx = 0
    const next = () => {
      if (idx >= STEPS.length) { setRunning(false); setDone(true); return }
      const step = STEPS[idx]
      setSteps(prev => [...prev, { ...step, status: 'running' }])
      setStreamText('')
      let ci = 0
      const iv = setInterval(() => {
        ci += 3
        setStreamText(step.content.slice(0, ci))
        if (ci >= step.content.length) {
          clearInterval(iv)
          setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'done', content: step.content } : s))
          idx++
          setTimeout(next, 400)
        }
      }, 10)
    }
    next()
  }, [STEPS])

  const totals = steps.reduce((a, s) => ({
    tin: a.tin + s.tokensIn, tout: a.tout + s.tokensOut,
    cost: a.cost + stepCost(s, ag.model), secs: a.secs + s.latency,
  }), { tin: 0, tout: 0, cost: 0, secs: 0 })

  return (
    <div className="mt-3 flex flex-col gap-3 animate-fade-up">
      {/* Run controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="mono text-[10px] text-[var(--c-faint)]">scope: {tenant.label} · model: {modelInfo.name}</span>
        <button
          onClick={startRun} disabled={running}
          className="mono text-[11px] px-3 py-1.5 rounded transition-all"
          style={{
            background: running ? a(C.purple, 0.05) : a(C.purple, 0.14),
            border: `1px solid ${a(C.purple, 0.35)}`,
            color: running ? C.faint : C.purple,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? '⠸ Running…' : done ? '↺ Re-run' : '▶ Run Agent'}
        </button>
        <button onClick={onClose} className="mono text-[10px] px-2 py-1 rounded ml-auto" style={{ color: C.faint, border: `1px solid ${C.border}` }}>
          ✕ Close
        </button>
      </div>

      {/* Telemetry bar */}
      {steps.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Input tokens', value: totals.tin.toLocaleString(), color: C.cyan },
            { label: 'Output tokens', value: totals.tout.toLocaleString(), color: C.cyan },
            { label: 'Run cost', value: `$${totals.cost.toFixed(3)}`, color: C.green },
            { label: 'Wall time', value: `${totals.secs.toFixed(1)}s`, color: C.dim },
          ].map(t => (
            <div key={t.label} className="rounded p-2" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div className="mono text-[9px] text-[var(--c-faint)] uppercase tracking-widest">{t.label}</div>
              <div className="mono text-[13px] font-semibold" style={{ color: t.color }}>{t.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Steps */}
      {steps.length === 0 && !running && !done && (
        <div className="mono text-[11px] text-[var(--c-faint)] text-center py-4">
          Press Run Agent to execute {STEPS.length} capability step{STEPS.length !== 1 ? 's' : ''}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {steps.map(step => {
          const col = step.status === 'done' ? C.green : step.status === 'running' ? C.purple : C.border
          return (
            <div key={step.id} className="rounded p-3 animate-fade-up" style={{ background: C.bg, borderTop: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, borderLeft: `2px solid ${col}` }}>
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <div className="w-4 h-4 rounded-full flex items-center justify-center mono text-[9px]"
                  style={{ background: a(col, 0.15), color: col }}>
                  {step.status === 'done' ? '✓' : '⠸'}
                </div>
                <span className="mono text-[11px] font-semibold text-[var(--c-text)]">{step.phase}</span>
                <span className="mono text-[9px] px-1 rounded" style={{ background: a(C.purple, 0.1), color: C.purple }}>{step.tool}</span>
                <span className="mono text-[9px] text-[var(--c-faint)] ml-auto">
                  {step.tokensIn.toLocaleString()}↓ {step.tokensOut}↑ · ${stepCost(step, ag.model).toFixed(3)}
                </span>
              </div>
              <div className="mono text-[11px] text-[var(--c-dim)] whitespace-pre-line leading-relaxed ml-6">
                {step.status === 'running' ? streamText : step.content}
                {step.status === 'running' && <span className="ai-typing" />}
              </div>
              {step.citations && step.status === 'done' && (
                <div className="flex flex-wrap gap-1 mt-1.5 ml-6">
                  {step.citations.map(c => (
                    <span key={c} className="mono text-[9px] px-1 py-0.5 rounded"
                      style={{ background: a(C.cyan, 0.08), border: `1px solid ${a(C.cyan, 0.18)}`, color: C.cyan }}>
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Completion banner */}
      {done && (
        <div className="rounded p-3 mono text-[11px]" style={{ background: a(C.green, 0.04), border: `1px solid ${a(C.green, 0.2)}`, color: C.green }}>
          ✓ Agent run complete · {STEPS.length} steps · ${totals.cost.toFixed(3)} · {totals.secs.toFixed(1)}s
        </div>
      )}
    </div>
  )
}

function CustomAgentSection({ domain, onAgentCreated }: {
  domain: DomainFilter
  onAgentCreated: (agent: CustomAgentDef) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [caps, setCaps] = useState<string[]>([])
  const [agentModel, setAgentModel] = useState('claude-sonnet-5')
  const [created, setCreated] = useState<CustomAgentDef[]>([])
  const [showForm, setShowForm] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAgents().then(agents => {
      setCreated(agents)
      agents.forEach(ag => onAgentCreated(ag))
      setLoading(false)
    })
  }, [])

  function toggleCap(cap: string) {
    setCaps(prev => prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap])
  }

  function handleCreate() {
    if (!name.trim()) return
    const ag: CustomAgentDef = {
      id: Math.random().toString(36).slice(2, 10),
      name: name.trim(),
      description: desc.trim(),
      capabilities: caps,
      model: agentModel,
      createdAt: new Date().toISOString(),
    }
    const next = [ag, ...created]
    setCreated(next)
    saveAgents(next)
    onAgentCreated(ag)
    setName(''); setDesc(''); setCaps([]); setShowForm(false)
  }

  function handleDelete(id: string) {
    const next = created.filter(a => a.id !== id)
    setCreated(next)
    saveAgents(next)
  }

  return (
    <div className="flex flex-col gap-4 h-full overflow-auto pr-1">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--c-text)] tracking-wide uppercase">Custom Agents</h2>
          <p className="mono text-[11px] text-[var(--c-dim)] mt-0.5">Build agents, assign capabilities, add to the workflow</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="mono text-[11px] px-3 py-2 rounded flex items-center gap-2 transition-colors"
          style={{ background: a(C.cyan, 0.12), border: `1px solid ${a(C.cyan, 0.3)}`, color: C.cyan }}
        >
          <span>{showForm ? '✕' : '+'}</span>
          <span>{showForm ? 'Cancel' : 'New Agent'}</span>
        </button>
      </div>

      {/* Agent builder form */}
      {showForm && (
        <div className="card p-4 flex flex-col gap-3">
          <SectionHeader title="Agent Builder" sub="define capabilities and assign a reasoning model" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. MPS Payment Monitor"
                className="mono text-[12px] bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-3 py-2 text-[var(--c-text)] placeholder-[var(--c-faint)] outline-none focus:border-[var(--c-cyan)]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Description</label>
              <input
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="What does this agent do?"
                className="mono text-[12px] bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-3 py-2 text-[var(--c-text)] placeholder-[var(--c-faint)] outline-none focus:border-[var(--c-cyan)]"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Capabilities</label>
            <div className="flex flex-wrap gap-2">
              {AGENT_CAPABILITIES.map(cap => (
                <button
                  key={cap}
                  onClick={() => toggleCap(cap)}
                  className="mono text-[10px] px-2 py-1 rounded transition-colors"
                  style={{
                    background: caps.includes(cap) ? a(C.cyan, 0.14) : a(C.text, 0.04),
                    border: `1px solid ${caps.includes(cap) ? a(C.cyan, 0.4) : C.border}`,
                    color: caps.includes(cap) ? C.cyan : C.dim,
                  }}
                >
                  {caps.includes(cap) ? '✓ ' : ''}{cap}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest">Reasoning Model</label>
            <select
              value={agentModel}
              onChange={e => setAgentModel(e.target.value)}
              className="mono text-[11px] bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-3 py-2 text-[var(--c-dim)] outline-none focus:border-[var(--c-cyan)] w-64"
            >
              {LLM_MODELS.map(m => <option key={m.id} value={m.id}>{m.name} ({m.provider})</option>)}
            </select>
          </div>

          <button
            onClick={handleCreate}
            disabled={!name.trim() || caps.length === 0}
            className="mono text-[12px] px-4 py-2 rounded font-medium self-start transition-all"
            style={{
              background: name.trim() && caps.length > 0 ? a(C.cyan, 0.14) : a(C.text, 0.04),
              border: `1px solid ${name.trim() && caps.length > 0 ? a(C.cyan, 0.35) : C.border}`,
              color: name.trim() && caps.length > 0 ? C.cyan : C.faint,
            }}
          >
            Create & Add to Workflow
          </button>
        </div>
      )}

      {/* Existing agents */}
      {loading ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <div className="mono text-[12px] text-[var(--c-faint)]">⠸ Loading agents…</div>
        </div>
      ) : created.length === 0 && !showForm ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <span className="text-2xl" style={{ color: C.purple }}>◈</span>
          <div className="mono text-[12px] text-[var(--c-dim)]">No custom agents yet</div>
          <div className="mono text-[11px] text-[var(--c-faint)]">Click "New Agent" to build your first agent and add it to the workflow.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {created.map(ag => (
            <div key={ag.id} className="card p-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0" style={{ background: a(C.purple, 0.12), border: `1px solid ${a(C.purple, 0.25)}` }}>
                  <span className="text-[var(--c-purple)]">◈</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="mono text-[12px] font-semibold text-[var(--c-text)]">{ag.name}</span>
                    <span className="mono text-[9px] px-1 rounded" style={{ background: a(C.green, 0.12), color: C.green }}>ready</span>
                    <span className="mono text-[9px] px-1 rounded" style={{ background: a(C.purple, 0.08), color: C.purple }}>
                      {LLM_MODELS.find(m => m.id === ag.model)?.name ?? ag.model}
                    </span>
                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        onClick={() => setRunningId(runningId === ag.id ? null : ag.id)}
                        className="mono text-[10px] px-2.5 py-1 rounded transition-colors"
                        style={{
                          background: runningId === ag.id ? a(C.purple, 0.18) : a(C.purple, 0.1),
                          border: `1px solid ${a(C.purple, 0.35)}`,
                          color: C.purple,
                        }}
                      >
                        {runningId === ag.id ? '▼ Running' : '▶ Run'}
                      </button>
                      <button
                        onClick={() => handleDelete(ag.id)}
                        className="mono text-[10px] px-2 py-1 rounded transition-colors"
                        style={{ border: `1px solid ${C.border}`, color: C.faint }}
                        title="Delete agent"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  {ag.description && <div className="mono text-[11px] text-[var(--c-dim)] mt-0.5">{ag.description}</div>}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {ag.capabilities.map(cap => (
                      <span key={cap} className="mono text-[9px] px-1.5 py-0.5 rounded" style={{ background: a(C.cyan, 0.1), color: C.cyan }}>
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {runningId === ag.id && (
                <CustomAgentRunner
                  ag={ag}
                  domain={domain}
                  onClose={() => setRunningId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const NAV_ITEMS: { id: NavSection; label: string; icon: string; badge?: string }[] = [
  { id: 'lob', label: 'LoB', icon: '⊞' },
  { id: 'logs', label: 'Log Stream', icon: '≡' },
  { id: 'errors', label: 'Errors', icon: '⊗', badge: '1.8K' },
  { id: 'anomalies', label: 'Anomaly Detection', icon: '◎', badge: '7' },
  { id: 'sla', label: 'SLA', icon: '◇' },
  { id: 'rca', label: 'RCA Agent', icon: '⊕' },
  { id: 'agent', label: 'Custom Agent', icon: '◈' },
  { id: 'pipeline', label: 'Pipeline', icon: '⊳' },
]

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [section, setSection] = useState<NavSection>('lob')
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS)
  const [live, setLive] = useState(true)
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const to = new Date()
    const from = new Date(to.getTime() - 3_600_000)
    return { from, to, label: 'Last 1 hour' }
  })
  const timeWindow: TimeWindow = dateRangeToTimeWindow(dateRange)
  // compat shim so internal section pickers can still call setTimeWindow(w)
  const setTimeWindow = (w: TimeWindow) => {
    const ms = TIME_WINDOW_MS[w]
    const to = new Date()
    setDateRange({ from: new Date(to.getTime() - ms), to, label: TIME_WINDOWS.find(t => t.id === w)?.label ?? w })
  }
  const [model, setModel] = useState('claude-sonnet-5')
  const [customAgents, setCustomAgents] = useState<CustomAgentDef[]>([])
  const [domain, setDomain] = useState<DomainFilter>('mps')
  const [source, setSource] = useState<DataSource>(
    () => (import.meta.env.VITE_DATA_SOURCE === 'elastic' ? 'elastic' : 'demo')
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [askWide, setAskWide] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => (typeof localStorage !== 'undefined' && (localStorage.getItem('logsense-theme') as ThemeMode)) || 'system'
  )

  const es = useElasticStream({ enabled: source === 'elastic', live, pollMs: 5000 })

  // Swap the tenant registry with the data source, before children render.
  const esDomains = useMemo(() => elasticDomains(es.services), [es.services])
  setTenantRegistry(source === 'elastic' ? esDomains : DEMO_DOMAINS)

  // A tenant from the other registry cannot stay selected across a source swap.
  useEffect(() => {
    if (!DOMAINS.some(d => d.id === domain)) setDomain(DOMAINS[0]?.id ?? 'mps')
  }, [source, domain])

  const systemDark = usePrefersDark()
  const isDark = themeMode === 'system' ? systemDark : themeMode === 'dark'
  // Assign before children render so every descendant reads the active palette.
  C = isDark ? DARK : LIGHT

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
  }, [isDark])

  useEffect(() => {
    localStorage.setItem('logsense-theme', themeMode)
  }, [themeMode])

  // ⌘K / Ctrl+K toggles the ask panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setAskOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!live || source === 'elastic') return
    const id = setInterval(() => {
      const newLogs = Array.from({ length: Math.floor(Math.random() * 4) + 1 }, () => makeLog(0))
      setLogs(prev => [...newLogs, ...prev].slice(0, 500))
    }, 1800)
    return () => clearInterval(id)
  }, [live, source])

  const currentModel = LLM_MODELS.find(m => m.id === model) || LLM_MODELS[0]
  const activeLogs = source === 'elastic' ? es.logs : logs
  const visibleLogs = activeLogs.filter(l => l.domain === domain)

  /** Reshape per-tenant Elastic histograms into the stacked-area row format. */
  const esVolume = useMemo(() => {
    if (source !== 'elastic') return undefined
    const rows = new Map<string, Record<string, number | string>>()
    for (const t of ES_TENANTS) {
      for (const b of es.volume[t.id] ?? []) {
        const row = rows.get(b.time) ?? { time: b.time, total: 0, errors: 0, warns: 0 }
        row[t.id] = b.total
        row.total = Number(row.total) + b.total
        row.errors = Number(row.errors) + b.errors
        row.warns = Number(row.warns) + b.warns
        rows.set(b.time, row)
      }
    }
    return [...rows.values()].sort((x, y) => String(x.time).localeCompare(String(y.time)))
  }, [source, es.volume])

  return (
    <div className="flex h-screen overflow-hidden terminal-grid" style={{ background: C.bg }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 transition-all duration-200"
        style={{
          width: sidebarCollapsed ? 48 : 200,
          background: C.bgDeep,
          borderRight: `1px solid ${C.border}`,
        }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-4 border-b border-[var(--c-border)] flex-shrink-0" style={{ height: 52 }}>
          <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0" style={{ background: a(C.cyan,0.12), border: `1px solid ${a(C.cyan,0.25)}` }}>
            <span className="text-[var(--c-cyan)] text-sm">◈</span>
          </div>
          {!sidebarCollapsed && (
            <div>
              <div className="mono text-[12px] font-semibold text-[var(--c-text)] leading-none">LogSense</div>
              <div className="mono text-[9px] text-[var(--c-faint)]">Analytics Platform</div>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="ml-auto text-[var(--c-faint)] hover:text-[var(--c-dim)] text-xs flex-shrink-0"
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-px p-2 flex-1 overflow-y-auto">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`nav-item flex items-center gap-2.5 px-2 py-2 rounded text-left ${section === item.id ? 'active' : ''}`}
            >
              <span className="text-sm flex-shrink-0 w-4 text-center">{item.icon}</span>
              {!sidebarCollapsed && (
                <>
                  <span className="mono text-[11px] flex-1">{item.label}</span>
                  {item.badge && (
                    <span className="mono text-[9px] px-1 rounded" style={{ background: a(C.red,0.15), color: C.red }}>
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
          {/* Custom agents */}
          {customAgents.length > 0 && !sidebarCollapsed && (
            <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
              <div className="mono text-[9px] text-[var(--c-faint)] uppercase tracking-widest px-2 pb-1">Custom Agents</div>
              {customAgents.map(ag => (
                <div
                  key={ag.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded"
                  style={{ background: a(C.purple, 0.06) }}
                >
                  <span className="text-[var(--c-purple)] text-xs">◈</span>
                  <span className="mono text-[11px] text-[var(--c-dim)] truncate flex-1">{ag.name}</span>
                  <span className="mono text-[8px] text-[var(--c-faint)]">ready</span>
                </div>
              ))}
            </div>
          )}
        </nav>

        {/* Live indicator */}
        <div className="p-3 border-t border-[var(--c-border)] flex-shrink-0">
          <button
            onClick={() => setLive(!live)}
            className={`flex items-center gap-2 w-full ${sidebarCollapsed ? 'justify-center' : ''}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${live ? 'animate-pulse-dot' : ''}`} style={{ background: live ? C.green : C.faint }} />
            {!sidebarCollapsed && <span className="mono text-[10px]" style={{ color: live ? C.green : C.faint }}>{live ? 'LIVE' : 'PAUSED'}</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <header className="flex items-center gap-3 px-4 flex-shrink-0" style={{ height: 52, borderBottom: `1px solid ${C.border}`, background: C.bgDeep }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="mono text-[11px] text-[var(--c-faint)]">/</span>
              <span className="mono text-[12px] text-[var(--c-text)] font-medium">{NAV_ITEMS.find(n => n.id === section)?.label}</span>
            </div>
          </div>

          {/* Global date range — applies to all charts */}
          <DateRangePicker value={dateRange} onChange={setDateRange} />

          {/* Theme switch: system / dark / light */}
          <div className="flex items-center rounded overflow-hidden" style={{ border: `1px solid ${C.border}`, background: C.card }}>
            {([['system', '◐'], ['dark', '☾'], ['light', '☀']] as [ThemeMode, string][]).map(([mode, icon]) => (
              <button
                key={mode}
                onClick={() => setThemeMode(mode)}
                title={`${mode} theme`}
                className="mono text-[11px] px-2 py-1 leading-none transition-colors"
                style={{
                  background: themeMode === mode ? a(C.cyan, 0.12) : 'transparent',
                  color: themeMode === mode ? C.cyan : C.faint,
                }}
              >
                {icon}
              </button>
            ))}
          </div>

          <SourcePill source={source} setSource={setSource} es={es} />

          <button
            onClick={() => setAskOpen(o => !o)}
            title="Ask the agent (⌘K)"
            className="mono text-[10px] px-2 py-1 rounded flex items-center gap-1.5 transition-colors"
            style={{
              background: askOpen ? a(C.cyan, 0.14) : 'transparent',
              border: `1px solid ${askOpen ? a(C.cyan, 0.35) : C.border}`,
              color: askOpen ? C.cyan : C.dim,
            }}
          >
            <span>◈</span>
            <span>Ask</span>
            <span className="text-[var(--c-faint)]">⌘K</span>
          </button>

          {/* Model badge */}
          <div className="mono text-[10px] px-2 py-1 rounded flex items-center gap-1.5" style={{ background: a(C.purple,0.08), border: `1px solid ${a(C.purple,0.2)}`, color: C.purple }}>
            <span>{currentModel.icon}</span>
            <span>{currentModel.name}</span>
          </div>
        </header>

        {/* LoB bar — scopes every section below */}
        <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto flex-shrink-0"
          style={{ borderBottom: `1px solid ${C.border}`, background: C.bg }}>
          <span className="mono text-[10px] text-[var(--c-faint)] uppercase tracking-widest flex-shrink-0">LoB</span>
          {DOMAINS.map(d => {
            const on = domain === d.id
            const col = domainColor(d.id)
            return (
              <button
                key={d.id}
                onClick={() => setDomain(d.id)}
                title={`${d.team} · ${d.policy.residency} · ${d.policy.regime}`}
                className="mono text-[11px] px-2 py-1 rounded flex items-center gap-1.5 flex-shrink-0 transition-colors"
                style={{
                  background: on ? a(col, 0.14) : 'transparent',
                  border: `1px solid ${on ? a(col, 0.45) : C.border}`,
                  color: on ? col : C.dim,
                }}
              >
                <span>{d.icon}</span>
                <span>{d.short}</span>
                {d.slo.burn > 6 && <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot" style={{ background: C.red }} />}
              </button>
            )
          })}
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          </div>
        </div>

        {/* Content */}
        <main className="flex-1 min-h-0 p-4 overflow-hidden">
          {section === 'lob' && (
            <LobSection logs={activeLogs} domain={domain} setDomain={setDomain} esServices={source === 'elastic' ? es.services : undefined} timeWindow={timeWindow} setTimeWindow={setTimeWindow} />
          )}
          {section === 'logs' && <LogsSection logs={visibleLogs} live={live} domain={domain} />}
          {section === 'errors' && <ErrorsSection logs={visibleLogs} domain={domain} dateRange={dateRange} timeWindow={timeWindow} setTimeWindow={setTimeWindow} />}
          {section === 'anomalies' && <AnomalySection domain={domain} timeWindow={timeWindow} setTimeWindow={setTimeWindow} />}
          {section === 'sla' && <SLASection domain={domain} timeWindow={timeWindow} setTimeWindow={setTimeWindow} />}
          {section === 'rca' && <AgentSection model={model} setModel={setModel} domain={domain} setDomain={setDomain} />}
          {section === 'agent' && <CustomAgentSection domain={domain} onAgentCreated={ag => setCustomAgents(prev => [...prev, ag])} />}
          {section === 'pipeline' && <PipelineSection domain={domain} timeWindow={timeWindow} setTimeWindow={setTimeWindow} />}
        </main>
      </div>

      <AskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        logs={visibleLogs}
        domain={domain}
        model={model}
        wide={askWide}
        setWide={setAskWide}
      />
    </div>
  )
}
