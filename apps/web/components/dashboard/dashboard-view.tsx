"use client"
// Renders the agent-written dashboard. Three tiers, first that passes wins:
// today's spec, the last-known-good spec, then the bundled default spec.
// Each candidate goes through the render gate against the live data; a
// candidate that passes but throws while rendering also falls through to the
// next tier. Off the spec tier, a quiet banner says which tier is showing and
// why (the first blocking issue). When the issue predates the data, a second
// quiet line says the words may be stale; the headline hides once the issue
// is more than a day old. Numbers are always live.
import type { Spec } from "@json-render/core"
import { JSONUIProvider, Renderer } from "@json-render/react"
import * as React from "react"
import { daysBetween, longDate, shortDate } from "@/components/dashboard/dates"
import { Eyebrow } from "@/components/dashboard/parts"
import { catalog, directives } from "@/lib/dashboard/catalog"
import defaultSpec from "@/lib/dashboard/default-spec.json"
import { registry } from "@/lib/dashboard/registry"
import {
  type GateIssue,
  renderGate,
  type SpecMeta,
  stripMeta,
} from "@/lib/dashboard/render-gate"
import { cn } from "@/lib/utils"

export type DashboardTier = "spec" | "lkg" | "default"

const TIER_LABEL: Record<DashboardTier, string> = {
  spec: "today's issue",
  lkg: "the last good issue",
  default: "the built-in layout",
}

interface Candidate {
  tier: DashboardTier
  spec: unknown
}

interface Rejection {
  tier: DashboardTier
  reason: string
}

export interface DashboardViewProps {
  spec: unknown
  lkg: unknown
  data: Record<string, unknown> | null
  /** Why `data` is null (from the endpoint), shown as the cause. */
  dataError?: string | null
  className?: string
}

type PropsSchema = {
  safeParse(v: unknown): { success: boolean; data?: unknown }
}
const COMPONENTS = catalog.data.components as unknown as Record<
  string,
  { props: PropsSchema }
>

/**
 * The spec json-render sees: meta stripped, and each element's props passed
 * through its catalog schema so zod defaults (gap, limit, format...) apply.
 * Bindings and text expressions keep their shape through the parse.
 */
function toRenderable(spec: unknown): Spec {
  const body = stripMeta(spec) as Spec
  const elements: Spec["elements"] = {}
  for (const [key, el] of Object.entries(body.elements)) {
    const parsed = COMPONENTS[el.type]?.props.safeParse(el.props ?? {})
    elements[key] = {
      ...el,
      props: (parsed?.success ? parsed.data : el.props) as Record<
        string,
        unknown
      >,
    }
  }
  return { root: body.root, elements }
}

function metaOf(spec: unknown): Partial<SpecMeta> | null {
  if (!spec || typeof spec !== "object") return null
  const m = (spec as { meta?: unknown }).meta
  return m && typeof m === "object" ? (m as Partial<SpecMeta>) : null
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined
}

/** The ledger as-of date the data document was built at. */
function dataAsOf(data: Record<string, unknown>): string | undefined {
  const derived = data.derived as
    | { freshness?: { asOf?: unknown } }
    | null
    | undefined
  return str(data.asOf) ?? str(derived?.freshness?.asOf)
}

/** Whole days the issue trails the data; 0 when current or unknown. */
function issueLag(issueDate: unknown, asOf: string | undefined): number {
  if (typeof issueDate !== "string" || !asOf) return 0
  const n = daysBetween(issueDate, asOf)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function firstError(issues: GateIssue[]): string {
  const i = issues.find((x) => x.severity === "error") ?? issues[0]
  if (!i) return "it did not pass the check"
  return i.element ? `${i.element}: ${i.message}` : i.message
}

export function DashboardView({
  spec,
  lkg,
  data,
  dataError,
  className,
}: DashboardViewProps) {
  // Tiers that passed the gate but threw while rendering, keyed to the
  // inputs they failed with so a new spec or lkg gets a fresh chance.
  const [crashed, setCrashed] = React.useState<{
    inputs: [unknown, unknown]
    tiers: Partial<Record<DashboardTier, string>>
  }>({ inputs: [spec, lkg], tiers: {} })
  const crashedTiers = React.useMemo(
    () =>
      crashed.inputs[0] === spec && crashed.inputs[1] === lkg
        ? crashed.tiers
        : {},
    [crashed, spec, lkg]
  )

  const choice = React.useMemo(() => {
    const candidates: Candidate[] = [
      { tier: "spec", spec },
      { tier: "lkg", spec: lkg },
      { tier: "default", spec: defaultSpec },
    ]
    const rejected: Rejection[] = []
    if (!data) return { chosen: null, rejected }
    for (const c of candidates) {
      if (c.spec === null || c.spec === undefined) {
        if (c.tier !== "default")
          rejected.push({ tier: c.tier, reason: "there is none yet" })
        continue
      }
      const crash = crashedTiers[c.tier]
      if (crash) {
        rejected.push({
          tier: c.tier,
          reason: `it failed to render (${crash})`,
        })
        continue
      }
      const gate = renderGate(c.spec, data)
      if (gate.ok)
        return {
          chosen: { ...c, renderable: toRenderable(c.spec) },
          rejected,
        }
      rejected.push({ tier: c.tier, reason: firstError(gate.issues) })
    }
    return { chosen: null, rejected }
  }, [spec, lkg, data, crashedTiers])

  const onCrash = React.useCallback(
    (tier: DashboardTier, message: string) =>
      setCrashed((prev) => {
        const same = prev.inputs[0] === spec && prev.inputs[1] === lkg
        return {
          inputs: [spec, lkg],
          tiers: { ...(same ? prev.tiers : {}), [tier]: message },
        }
      }),
    [spec, lkg]
  )

  // data-dash-root / data-dash-tier: read by `just dashboard-look`.
  if (!data)
    return (
      <div
        data-dash-root
        data-dash-tier="none"
        className="flex flex-col gap-1 py-10 text-sm"
      >
        <p className="font-medium">No dashboard data to show.</p>
        <p className="text-muted-foreground">
          {dataError
            ? `The data could not be built: ${dataError}`
            : "The endpoint returned no data and gave no reason."}
        </p>
      </div>
    )

  const { chosen, rejected } = choice
  if (!chosen)
    return (
      <div
        data-dash-root
        data-dash-tier="none"
        className="flex flex-col gap-1 py-10 text-sm"
      >
        <p className="font-medium">The dashboard could not render.</p>
        {rejected.map((r) => (
          <p key={r.tier} className="text-muted-foreground">
            {TIER_LABEL[r.tier]}: {r.reason}
          </p>
        ))}
      </div>
    )

  const isDefault = chosen.tier === "default"
  const meta = metaOf(chosen.spec)
  const lag = isDefault ? 0 : issueLag(meta?.issueDate, dataAsOf(data))
  const firstRejection = rejected[0]
  return (
    <div
      data-dash-root
      data-dash-tier={chosen.tier}
      className={cn("flex flex-col gap-4", className)}
    >
      {chosen.tier !== "spec" && firstRejection && (
        <TierBanner tier={chosen.tier} rejection={firstRejection} />
      )}
      {dataError && <QuietLine>{dataError}</QuietLine>}
      {lag > 0 && meta?.issueDate && (
        <QuietLine>
          Issue from {shortDate(meta.issueDate)}. Numbers are live; the words
          may be out of date.
        </QuietLine>
      )}
      {!isDefault && <IssueHeader meta={meta} hideHeadline={lag > 1} />}
      <TierBoundary key={chosen.tier} tier={chosen.tier} onCrash={onCrash}>
        <JSONUIProvider
          registry={registry}
          initialState={data}
          directives={directives}
        >
          <Renderer spec={chosen.renderable} registry={registry} />
        </JSONUIProvider>
      </TierBoundary>
    </div>
  )
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="mt-[5px] size-1.5 shrink-0 rounded-full bg-runway-warn"
      />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function TierBanner({
  tier,
  rejection,
}: {
  tier: DashboardTier
  rejection: Rejection
}) {
  const what =
    rejection.tier === "spec" ? "Today's issue" : "The last good issue"
  return (
    <QuietLine>
      Showing {TIER_LABEL[tier]}. {what} did not render: {rejection.reason}
    </QuietLine>
  )
}

/** Date, lens and headline of an agent issue (never the default tier). */
function IssueHeader({
  meta,
  hideHeadline,
}: {
  meta: Partial<SpecMeta> | null
  hideHeadline: boolean
}) {
  if (!meta) return null
  const headline = hideHeadline ? null : meta.headline
  const parts = [
    meta.issueDate ? longDate(meta.issueDate) : null,
    meta.lens && meta.lens !== "default" ? `${meta.lens} lens` : null,
  ].filter(Boolean)
  if (parts.length === 0 && !headline) return null
  return (
    <header className="flex flex-col gap-1.5">
      {parts.length > 0 && <Eyebrow>{parts.join(" · ")}</Eyebrow>}
      {headline && (
        <h1 className="max-w-[40ch] text-[26px] leading-[1.25] font-medium tracking-tight text-balance">
          {headline}
        </h1>
      )}
    </header>
  )
}

/** Catches a render crash in one tier and hands it to the parent. */
class TierBoundary extends React.Component<
  {
    tier: DashboardTier
    onCrash: (tier: DashboardTier, message: string) => void
    children: React.ReactNode
  },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.props.onCrash(this.props.tier, message)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
