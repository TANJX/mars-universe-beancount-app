"use client"
// React implementations of the dashboard catalog (catalog.ts). json-render
// resolves every `{ "$state": ... }` binding and every `$format` / `$concat`
// text expression before a component runs, so components receive plain
// values (ResolvedProps). The view normalizes props through the catalog
// schemas first, so zod defaults are applied; components still guard against
// missing or malformed data, because the lkg and default tiers may predate
// today's data shape. Look: tokens from globals.css only, tabular numbers,
// U+2212 minus via formatMoney.
import { defineRegistry, useStateValue } from "@json-render/react"
import { AlertTriangle, CircleAlert, Info } from "lucide-react"
import type * as React from "react"

import {
  PaceLines,
  Sparkline,
  sparkValues,
  TONE_STROKE,
} from "@/components/dashboard/charts"
import {
  InsightsView,
  MarketMovesList,
  NewsListView,
  PlanTimelineView,
  RecentActivityList,
} from "@/components/dashboard/context"
import {
  ago,
  daysBetween,
  relDate,
  shortDate,
} from "@/components/dashboard/dates"
import {
  deltaClass,
  Empty,
  Eyebrow,
  formatValue,
  isNum,
  KindIcon,
  Num,
  signedUsd,
  usd,
} from "@/components/dashboard/parts"
import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

import {
  type ComponentName,
  catalog,
  type FindingItem,
  type FindingKind,
  type NeedsYouItem,
  type PlanEvent,
  type ResolvedProps,
  type StaleAccount,
} from "./catalog"

type P<K extends ComponentName> = ResolvedProps<K>
const res = <K extends ComponentName>(props: unknown) => props as P<K>

/** The ledger as-of date from the data document, for relative dates. */
function useAsOf(): string | undefined {
  const v = useStateValue<unknown>("/asOf")
  return typeof v === "string" ? v : undefined
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

const GAP = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const

// ── Layout ─────────────────────────────────────────────────────────────

function StackView({
  p,
  children,
}: {
  p: P<"Stack">
  children?: React.ReactNode
}) {
  // A vertical Stack grows its last child, so a Stack inside a stretched
  // Grid cell ends level with its neighbours instead of leaving a hole.
  return (
    <div
      className={cn(
        "flex min-w-0",
        p.direction === "horizontal"
          ? "flex-row flex-wrap items-start"
          : "flex-col [&>:last-child]:flex-1",
        GAP[p.gap ?? "md"]
      )}
    >
      {children}
    </div>
  )
}

// Columns follow the width the issue actually has (the `issue` container in
// today-issue.tsx), not the viewport: with the sidebar panel open, a 900px
// window leaves the page about 520px. Two columns from 768px of content,
// three from 672px.
const GRID_COLS = {
  1: "",
  2: "@3xl/issue:grid-cols-2",
  3: "@2xl/issue:grid-cols-3",
} as const
const GRID_RATIO = {
  equal: "",
  "wide-left": "@3xl/issue:grid-cols-[3fr_2fr]",
  "wide-right": "@3xl/issue:grid-cols-[2fr_3fr]",
} as const

function GridView({
  p,
  children,
}: {
  p: P<"Grid">
  children?: React.ReactNode
}) {
  const cols = p.columns ?? 2
  const ratio = cols === 2 ? (p.ratio ?? "equal") : "equal"
  return (
    <div
      className={cn(
        "grid grid-cols-1 *:min-w-0",
        (p.align ?? "stretch") === "start" ? "items-start" : "items-stretch",
        ratio === "equal" ? GRID_COLS[cols] : GRID_RATIO[ratio],
        GAP[p.gap ?? "md"]
      )}
    >
      {children}
    </div>
  )
}

function PanelView({
  p,
  children,
  action,
}: {
  p: P<"Panel">
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  // Title first, then one muted line: the heading is what the eye finds.
  // `eyebrow` is the v3 name of the subtitle; older issues still render.
  const subtitle = p.subtitle ?? p.eyebrow
  return (
    <Card
      className={cn(
        "@container/panel h-full gap-0 overflow-hidden p-0",
        p.lead && "shadow-(--elev-card) ring-foreground/15"
      )}
    >
      <div
        className={cn(
          "flex items-start justify-between gap-3 px-4",
          p.lead ? "pt-4 pb-3" : "pt-3.5 pb-2"
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            className={cn(
              "text-pretty text-foreground",
              p.lead
                ? "text-[17px] leading-snug font-medium tracking-tight"
                : "text-sm leading-5 font-medium"
            )}
          >
            {p.title}
          </h2>
          {subtitle && (
            <p className="text-xs text-pretty text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="flex flex-col pb-3">{children}</div>
    </Card>
  )
}

// ── Note ───────────────────────────────────────────────────────────────

const NOTE_TONE = {
  info: {
    Icon: Info,
    frame: "bg-card ring-foreground/10",
    icon: "text-muted-foreground",
  },
  warn: {
    Icon: AlertTriangle,
    frame: "bg-runway-warn/8 ring-runway-warn/30",
    icon: "text-runway-warn",
  },
  crit: {
    Icon: CircleAlert,
    frame: "bg-runway-crit/8 ring-runway-crit/30",
    icon: "text-runway-crit",
  },
} as const

function NoteView({ p }: { p: P<"Note"> }) {
  const tone = NOTE_TONE[p.tone ?? "info"] ?? NOTE_TONE.info
  const text = typeof p.text === "string" ? p.text : ""
  return (
    <div
      role={p.tone === "info" ? undefined : "status"}
      className={cn("flex gap-3 rounded-xl px-4 py-3 ring-1", tone.frame)}
    >
      <tone.Icon
        size={16}
        className={cn("mt-0.5 shrink-0", tone.icon)}
        aria-hidden="true"
      />
      <div className="min-w-0">
        {p.title && (
          <div className="text-sm font-medium text-foreground">{p.title}</div>
        )}
        <p className="max-w-[68ch] text-[15px] leading-relaxed text-pretty text-foreground/90">
          {text || (
            <span className="text-muted-foreground">No brief today.</span>
          )}
        </p>
      </div>
    </div>
  )
}

// ── NetWorthHero ───────────────────────────────────────────────────────

function NetWorthHeroView({ p }: { p: P<"NetWorthHero"> }) {
  const values = sparkValues(p.series, p.field ?? "netWorth")
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-8">
      <div className="min-w-0">
        <Eyebrow className="mb-1.5">{p.label ?? "Net worth"}</Eyebrow>
        {isNum(p.value) ? (
          <Money
            value={p.value}
            minimumFractionDigits={0}
            maximumFractionDigits={0}
            className="text-4xl leading-none font-medium"
          />
        ) : (
          <span className="text-4xl leading-none font-medium text-muted-foreground">
            n/a
          </span>
        )}
        {(isNum(p.d30) || isNum(p.ytd)) && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            {isNum(p.d30) && (
              <span>
                <Num className={deltaClass(p.d30, "up")}>
                  {signedUsd(p.d30)}
                </Num>{" "}
                <span className="text-xs text-muted-foreground">30 days</span>
              </span>
            )}
            {isNum(p.ytd) && (
              <span>
                <Num className={deltaClass(p.ytd, "up")}>
                  {signedUsd(p.ytd)}
                </Num>{" "}
                <span className="text-xs text-muted-foreground">this year</span>
              </span>
            )}
          </div>
        )}
      </div>
      {values.length > 1 && (
        <div className="w-full md:w-72 md:shrink-0">
          <Sparkline values={values} height={64} />
        </div>
      )}
    </div>
  )
}

// ── StatTile ───────────────────────────────────────────────────────────

function StatTileView({ p }: { p: P<"StatTile"> }) {
  const format = p.format ?? "money"
  const tone = p.tone ?? "neutral"
  const field =
    p.sparkField ??
    (Array.isArray(p.spark) && typeof p.spark[0] === "object"
      ? "value"
      : undefined)
  const spark = sparkValues(p.spark, field)
  return (
    <section className="flex h-full min-h-[120px] flex-col gap-1.5 rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10">
      <header className="flex items-center gap-1.5">
        {(tone === "warn" || tone === "crit") && (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              tone === "warn" ? "bg-runway-warn" : "bg-runway-crit"
            )}
          />
        )}
        <Eyebrow className="truncate">{p.label}</Eyebrow>
      </header>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {isNum(p.value) ? (
          // Tone marks the tile (dot, spark), never the value: a green
          // spend total reads as income.
          <Num className="text-2xl leading-tight font-medium">
            {formatValue(p.value, format)}
          </Num>
        ) : (
          <span className="text-2xl leading-tight font-medium text-muted-foreground">
            n/a
          </span>
        )}
        {isNum(p.delta) && (
          <span className="text-xs">
            <Num className={deltaClass(p.delta, p.goodWhen ?? "up")}>
              {formatValue(p.delta, format, true)}
            </Num>
            {p.deltaLabel && (
              <span className="text-muted-foreground"> {p.deltaLabel}</span>
            )}
          </span>
        )}
      </div>
      {p.caption && (
        <p className="text-xs text-muted-foreground">{p.caption}</p>
      )}
      {spark.length > 1 && (
        <div className="mt-auto pt-1">
          <Sparkline values={spark} height={36} color={TONE_STROKE[tone]} />
        </div>
      )}
    </section>
  )
}

// ── PaceChart ──────────────────────────────────────────────────────────

const PACE_HEIGHT = { sm: 64, md: 120, lg: 180 } as const

function PaceChartView({ p }: { p: P<"PaceChart"> }) {
  const mtd = arr<unknown>(p.mtdCurve).filter(isNum)
  const usual = arr<unknown>(p.usualCurve).filter(isNum)
  const height = PACE_HEIGHT[p.height ?? "sm"]
  if (mtd.length === 0 && usual.length === 0)
    return <Empty>No day-to-day spending recorded this month yet.</Empty>
  const under = isNum(p.delta) ? p.delta <= 0 : null
  return (
    <div className="flex flex-col gap-2 px-4 py-1">
      {(isNum(p.delta) || isNum(p.usualMonth)) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          {isNum(p.delta) ? (
            <span
              className={
                under
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }
            >
              <Num>{usd(Math.abs(p.delta))}</Num> {under ? "under" : "over"}{" "}
              usual
            </span>
          ) : (
            <span />
          )}
          {isNum(p.usualMonth) && (
            <span className="text-xs text-muted-foreground">
              usual <Num>{usd(p.usualMonth)}</Num> a month
            </span>
          )}
        </div>
      )}
      <PaceLines mtd={mtd} usual={usual} height={height} />
    </div>
  )
}

// ── EventList ──────────────────────────────────────────────────────────

function EventRow({
  e,
  asOf,
  showBalance,
}: {
  e: PlanEvent
  asOf?: string
  showBalance: boolean
}) {
  const amount = isNum(e.amount) ? e.amount : null
  // The note goes under the label, so the label never truncates for it.
  // In a narrow panel the balance stacks under the amount.
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 text-sm">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">
        {relDate(e.date, asOf)}
      </span>
      <KindIcon kind={e.kind} className="shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{e.label}</span>
        {e.note && (
          <span className="truncate text-xs text-muted-foreground">
            {e.note}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end @md/panel:flex-row @md/panel:items-baseline @md/panel:gap-3">
        {e.kind === "info" || amount === null ? (
          <span className="text-xs text-muted-foreground">No cash</span>
        ) : (
          <Num
            className={cn(
              "text-sm",
              amount > 0 && "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {signedUsd(amount, 2)}
          </Num>
        )}
        {showBalance && (
          <Num className="text-right text-xs text-muted-foreground @md/panel:w-20">
            {isNum(e.balance) ? usd(e.balance) : ""}
          </Num>
        )}
      </span>
    </div>
  )
}

function EventListView({ p }: { p: P<"EventList"> }) {
  const asOf = useAsOf()
  const kinds = p.kinds && p.kinds.length > 0 ? new Set(p.kinds) : null
  const within = p.withinDays
  const all = arr<PlanEvent>(p.items)
    .filter((e) => e && typeof e.date === "string")
    .filter((e) => !kinds || kinds.has(e.kind))
    .filter((e) => {
      if (!within || !asOf) return true
      return daysBetween(asOf, e.date) <= within
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const limit = p.limit ?? 8
  const shown = all.slice(0, limit)
  const showBalance = p.showBalance ?? true
  if (shown.length === 0)
    return (
      <Empty>
        {within
          ? `Nothing scheduled in the next ${within} days.`
          : "Nothing scheduled."}
      </Empty>
    )
  return (
    <div className="flex flex-col">
      {showBalance && (
        <div className="hidden justify-end px-4 pb-0.5 text-[11px] text-muted-foreground @md/panel:flex">
          Cash after
        </div>
      )}
      {shown.map((e, i) => (
        <EventRow
          key={e.id ?? `${e.date}-${i}`}
          e={e}
          asOf={asOf}
          showBalance={showBalance}
        />
      ))}
      {all.length > shown.length && (
        <div className="px-4 pt-1 text-xs text-muted-foreground">
          {all.length - shown.length} more later
        </div>
      )}
    </div>
  )
}

// ── NeedsYou ───────────────────────────────────────────────────────────

function NeedsYouView({ p }: { p: P<"NeedsYou"> }) {
  const asOf = useAsOf()
  const items = arr<NeedsYouItem>(p.items).filter(
    (n) => n && typeof n.date === "string"
  )
  const shown = items.slice(0, p.limit ?? 6)
  if (shown.length === 0)
    return (
      <Empty>{p.emptyText ?? "Nothing due in the next three weeks."}</Empty>
    )
  return (
    <div className="flex flex-col">
      {shown.map((n, i) => (
        <div
          key={`${n.date}-${n.title}-${i}`}
          className="flex items-center gap-3 px-4 py-2"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <KindIcon kind={n.kind} size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {n.title}
            </span>
            {n.detail && (
              <span className="block truncate text-xs text-muted-foreground">
                {n.detail}
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relDate(n.date, asOf)}
          </span>
        </div>
      ))}
      {items.length > shown.length && (
        <div className="px-4 pt-1 text-xs text-muted-foreground">
          {items.length - shown.length} more
        </div>
      )}
    </div>
  )
}

// ── Findings ───────────────────────────────────────────────────────────

const FINDING_TAG: Record<FindingKind, string> = {
  drift: "Drift",
  settled: "Settled",
  opened: "Opened",
  statement: "Statement",
  skip: "Skipped",
  note: "Note",
}

/** Whole dollars when the amount is whole, else cents. */
function findingUsd(n: number): string {
  return usd(n, Number.isInteger(n) ? 0 : 2)
}

function FindingAmount({ f }: { f: FindingItem }) {
  if (f.kind === "drift" && isNum(f.from) && isNum(f.to))
    return (
      <Num className="shrink-0 text-sm">
        <span className="text-muted-foreground">{findingUsd(f.from)}</span>
        <span aria-hidden="true" className="px-1 text-muted-foreground">
          {"\u2192"}
        </span>
        <span className="sr-only"> to </span>
        {findingUsd(f.to)}
      </Num>
    )
  if (isNum(f.amount))
    return <Num className="shrink-0 text-sm">{findingUsd(f.amount)}</Num>
  return null
}

/** An empty list renders nothing unless the spec gives emptyText. */
function FindingsView({ p }: { p: P<"Findings"> }) {
  const asOf = useAsOf()
  const items = arr<FindingItem>(p.items).filter(
    (f) => f && typeof f.title === "string" && typeof f.kind === "string"
  )
  const shown = items.slice(0, p.limit ?? 6)
  if (shown.length === 0)
    return p.emptyText ? <Empty>{p.emptyText}</Empty> : null
  return (
    <ul className="flex flex-col">
      {shown.map((f, i) => {
        const sub = [
          f.account,
          typeof f.date === "string" ? relDate(f.date, asOf) : null,
        ].filter(Boolean)
        return (
          <li
            key={f.id ?? `${f.kind}-${i}`}
            className="flex items-center gap-3 px-4 py-1.5"
          >
            <span className="w-[68px] shrink-0">
              <span className="inline-block rounded bg-muted px-1.5 py-px text-[11px] leading-4 text-muted-foreground">
                {FINDING_TAG[f.kind] ?? f.kind}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{f.title}</span>
              {sub.length > 0 && (
                <span className="block truncate text-xs text-muted-foreground">
                  {sub.join(" · ")}
                </span>
              )}
            </span>
            <FindingAmount f={f} />
          </li>
        )
      })}
      {items.length > shown.length && (
        <li className="px-4 pt-1 text-xs text-muted-foreground">
          {items.length - shown.length} more
        </li>
      )}
    </ul>
  )
}

// ── Freshness ──────────────────────────────────────────────────────────

function FreshnessView({ p }: { p: P<"Freshness"> }) {
  const f = p.freshness && typeof p.freshness === "object" ? p.freshness : null
  const stale = arr<StaleAccount>(p.stale).filter(
    (s) => s && typeof s.account === "string"
  )
  const compact = p.compact ?? true
  if (!f)
    return (
      <span className="text-xs text-muted-foreground">Freshness unknown</span>
    )
  const line = (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <span>As of {shortDate(f.asOf)}</span>
      <span aria-hidden="true">·</span>
      <span title={f.generatedAt}>built {ago(f.generatedAt)}</span>
      {f.ledgerDirty && (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-runway-warn">uncommitted edits</span>
        </>
      )}
      {stale.length > 0 && compact && (
        <>
          <span aria-hidden="true">·</span>
          <span
            className="text-runway-warn"
            title={stale.map((s) => `${s.account}: ${s.reason}`).join("\n")}
          >
            {stale.length} stale
          </span>
        </>
      )}
    </span>
  )
  if (compact || stale.length === 0) return line
  return (
    <div className="flex flex-col gap-1.5 px-4 py-1">
      {line}
      <ul className="flex flex-col gap-1">
        {stale.map((s, i) => (
          <li
            key={`${s.account}-${i}`}
            className="flex items-baseline gap-2 text-sm"
          >
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-runway-warn"
            />
            <span className="min-w-0 truncate">{s.account}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {s.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Context (catalog v3) ───────────────────────────────────────────────
// The views live in components/dashboard/context.tsx; these wrappers only
// pass the resolved props and the ledger as-of date through.

function RecentActivityView({ p }: { p: P<"RecentActivity"> }) {
  const asOf = useAsOf()
  return (
    <RecentActivityList
      items={p.items}
      limit={p.limit ?? 8}
      withinDays={p.withinDays}
      showAccount={p.showAccount ?? true}
      asOf={asOf}
    />
  )
}

function MarketMovesView({ p }: { p: P<"MarketMoves"> }) {
  return (
    <MarketMovesList
      indices={p.indices}
      holdings={p.holdings}
      asOf={p.asOf}
      note={p.note}
      limit={p.limit ?? 6}
    />
  )
}

function NewsView({ p }: { p: P<"NewsList"> }) {
  const asOf = useAsOf()
  return (
    <NewsListView
      items={p.items}
      limit={p.limit ?? 5}
      emptyText={p.emptyText}
      asOf={asOf}
    />
  )
}

function PlanView({ p }: { p: P<"PlanTimeline"> }) {
  const asOf = useAsOf()
  return (
    <PlanTimelineView
      items={p.items}
      limit={p.limit ?? 8}
      withinDays={p.withinDays}
      emptyText={p.emptyText}
      asOf={asOf}
    />
  )
}

function InsightsPanelView({ p }: { p: P<"Insights"> }) {
  const asOf = useAsOf()
  return (
    <InsightsView
      items={p.items}
      limit={p.limit ?? 4}
      kinds={p.kinds}
      layout={p.layout ?? "list"}
      asOf={asOf}
    />
  )
}

// ── Registry ───────────────────────────────────────────────────────────

export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <StackView p={res<"Stack">(props)}>{children}</StackView>
    ),
    Grid: ({ props, children }) => (
      <GridView p={res<"Grid">(props)}>{children}</GridView>
    ),
    Panel: ({ props, children, slots }) => (
      <PanelView p={res<"Panel">(props)} action={slots?.action}>
        {children}
      </PanelView>
    ),
    Note: ({ props }) => <NoteView p={res<"Note">(props)} />,
    NetWorthHero: ({ props }) => (
      <NetWorthHeroView p={res<"NetWorthHero">(props)} />
    ),
    StatTile: ({ props }) => <StatTileView p={res<"StatTile">(props)} />,
    PaceChart: ({ props }) => <PaceChartView p={res<"PaceChart">(props)} />,
    EventList: ({ props }) => <EventListView p={res<"EventList">(props)} />,
    NeedsYou: ({ props }) => <NeedsYouView p={res<"NeedsYou">(props)} />,
    Findings: ({ props }) => <FindingsView p={res<"Findings">(props)} />,
    RecentActivity: ({ props }) => (
      <RecentActivityView p={res<"RecentActivity">(props)} />
    ),
    MarketMoves: ({ props }) => (
      <MarketMovesView p={res<"MarketMoves">(props)} />
    ),
    NewsList: ({ props }) => <NewsView p={res<"NewsList">(props)} />,
    PlanTimeline: ({ props }) => <PlanView p={res<"PlanTimeline">(props)} />,
    Insights: ({ props }) => <InsightsPanelView p={res<"Insights">(props)} />,
    Freshness: ({ props }) => <FreshnessView p={res<"Freshness">(props)} />,
  },
})
