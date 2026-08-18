"use client"

// PROTOTYPE — delete with the rest of app/(ledger)/proto/.
//
// Pieces every variant is allowed to share: the chart marks and the numeric
// atoms. What the variants must NOT share is *composition* — which module
// leads, what gets a chart vs. a sentence, how much room holdings take. That
// is the axis they diverge on.

import * as React from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  formatChartDate,
  MoneyTooltip,
} from "@/components/charts/chart-tooltip"
import { Money } from "@/components/primitives/money"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import { formatMoney, MINUS } from "@/lib/format"
import { cn } from "@/lib/utils"

import {
  type ContributionRoom,
  DRIFT_THRESHOLD_PP,
  type DriftRow,
  type Holding,
  PRICE_ASOF,
  type SeriesPoint,
  type Sleeve,
  type SleeveTotals,
  YEAR_ELAPSED,
} from "./mock"

export const ALLOC_RAMP = [
  "var(--alloc-1)",
  "var(--alloc-2)",
  "var(--alloc-3)",
  "var(--alloc-4)",
  "var(--alloc-5)",
  "var(--alloc-6)",
  "var(--alloc-7)",
]

/** Ramp step by rank, clamped so an 8th+ row reuses the lightest step. */
export function rampAt(i: number): string {
  return ALLOC_RAMP[Math.min(i, ALLOC_RAMP.length - 1)]
}

// ─── numeric atoms ────────────────────────────────────────────────────────

export function Pct({
  value,
  className,
  digits = 1,
  signed = true,
}: {
  value: number
  className?: string
  digits?: number
  signed?: boolean
}) {
  const sign = value < 0 ? MINUS : signed ? "+" : ""
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {sign}
      {Math.abs(value).toFixed(digits)}%
    </span>
  )
}

/** Signed gain, tinted. Emerald/rose are the system's existing P/L tones. */
export function Gain({
  value,
  pct,
  className,
}: {
  value: number
  pct?: number
  className?: string
}) {
  const tone = value >= 0 ? "pos" : "neg"
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <Money value={value} tone={tone} maximumFractionDigits={0} />
      {pct != null && (
        <Pct
          value={pct}
          className={
            value >= 0
              ? "text-emerald-600 text-xs dark:text-emerald-400"
              : "text-rose-600 text-xs dark:text-rose-400"
          }
        />
      )}
    </span>
  )
}

export function Units({ value }: { value: number }) {
  // Whole shares read as integers; fractional positions keep enough places to
  // stay honest without turning the column into noise.
  const s = Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      })
  return <span className="font-mono text-xs tabular-nums">{s}</span>
}

/** Uppercase micro-label. Tracking loosened — caps default too tight. */
export function Label({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]",
        className
      )}
    >
      {children}
    </div>
  )
}

export function StaleBadge() {
  const days = Math.round(
    (new Date("2026-08-17").getTime() - new Date(PRICE_ASOF).getTime()) /
      86_400_000
  )
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-700 tabular-nums dark:text-amber-400">
      <span aria-hidden>◆</span>
      prices {days}d old
    </span>
  )
}

// ─── value vs cost ────────────────────────────────────────────────────────

const VC_CONFIG: ChartConfig = {
  value: { label: "Market value", color: "var(--primary)" },
  cost: { label: "Cost basis", color: "var(--muted-foreground)" },
}

/**
 * Emphasis form, not categorical: market value is the subject (filled area in
 * the accent hue), cost basis is context (a thin dashed line). The gap between
 * them reads directly as unrealized gain — which is the whole point of putting
 * them on one chart. Same unit, one axis; never a second y-scale.
 */
export function ValueCostChart({
  data,
  height = "h-56",
  onHover,
}: {
  data: SeriesPoint[]
  height?: string
  onHover?: (p: SeriesPoint | null) => void
}) {
  const rows = data.map((p) => ({
    month: p.date.slice(0, 7),
    value: p.value,
    cost: p.cost,
    raw: p,
  }))
  return (
    <ChartContainer config={VC_CONFIG} className={cn("w-full", height)}>
      <AreaChart
        data={rows}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const p = (
            e as { activePayload?: Array<{ payload?: { raw?: SeriesPoint } }> }
          )?.activePayload?.[0]?.payload?.raw
          onHover?.(p ?? null)
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <defs>
          <linearGradient id="proto-value-fill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-value)"
              stopOpacity={0.3}
            />
            <stop
              offset="55%"
              stopColor="var(--color-value)"
              stopOpacity={0.1}
            />
            <stop
              offset="100%"
              stopColor="var(--color-value)"
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
          minTickGap={32}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
          width={52}
          tickFormatter={(v) => `$${Math.round((v as number) / 1000)}k`}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--color-value)", strokeOpacity: 0.3 }}
          content={<MoneyTooltip granularity="month" />}
        />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="url(#proto-value-fill)"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
        <Line
          dataKey="cost"
          type="monotone"
          stroke="var(--color-cost)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function ValueCostLegend() {
  return (
    <div className="flex items-center gap-3.5">
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-2 w-2.5 rounded-[2px]"
          style={{ background: "var(--primary)" }}
        />
        Market value
      </span>
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-0 w-2.5 border-t border-dashed"
          style={{ borderColor: "var(--muted-foreground)" }}
        />
        Cost basis
      </span>
    </div>
  )
}

// ─── allocation: ranked bars ──────────────────────────────────────────────

export interface ShareRow {
  key: string
  label: string
  value: number
  share: number
}

/**
 * Ranked horizontal bars. Identity comes from the row label, so colour is
 * never load-bearing — which is what lets this form carry 42 rows where a
 * stacked bar would need an 8-hue cap and a 20% "Other" slice.
 */
export function RankedBars({
  rows,
  max,
  showValue = true,
}: {
  rows: ShareRow[]
  max?: number
  showValue?: boolean
}) {
  const top = rows[0]?.share ?? 1
  const shown = max ? rows.slice(0, max) : rows
  const rest = max ? rows.slice(max) : []
  const restValue = rest.reduce((a, r) => a + r.value, 0)
  const restShare = rest.reduce((a, r) => a + r.share, 0)
  return (
    <div className="flex flex-col">
      {shown.map((r, i) => (
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-[5px]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px]">{r.label}</span>
          </div>
          <div className="flex items-center gap-2.5">
            {showValue && (
              <Money
                value={r.value}
                maximumFractionDigits={0}
                className="w-20 text-right text-xs text-muted-foreground"
              />
            )}
            <Pct
              value={r.share}
              signed={false}
              className="w-11 text-right text-xs"
            />
            <span className="h-[5px] w-24 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(2, (r.share / top) * 100)}%`,
                  background: rampAt(i),
                }}
              />
            </span>
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t py-[5px] text-muted-foreground">
          <span className="truncate text-[13px]">
            {rest.length} smaller positions
          </span>
          <div className="flex items-center gap-2.5">
            {showValue && (
              <Money
                value={restValue}
                maximumFractionDigits={0}
                className="w-20 text-right text-xs"
              />
            )}
            <Pct
              value={restShare}
              signed={false}
              className="w-11 text-right text-xs"
            />
            <span className="h-[5px] w-24 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-muted-foreground/25"
                style={{ width: `${Math.max(2, (restShare / top) * 100)}%` }}
              />
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Single stacked share bar. Compact, but colour *is* identity here for every
 * segment too small to hold an inline label — that is this form's real cost,
 * and why a legend below is mandatory rather than optional.
 */
export function StackedShareBar({
  rows,
  cap = 7,
}: {
  rows: ShareRow[]
  cap?: number
}) {
  const head = rows.slice(0, cap)
  const tail = rows.slice(cap)
  const tailShare = tail.reduce((a, r) => a + r.share, 0)
  const segments = [
    ...head.map((r, i) => ({ ...r, color: rampAt(i) })),
    ...(tail.length
      ? [
          {
            key: "__rest",
            label: `${tail.length} others`,
            value: tail.reduce((a, r) => a + r.value, 0),
            share: tailShare,
            color: "var(--muted)",
          },
        ]
      : []),
  ]
  return (
    <div className="flex flex-col gap-3">
      {/* 2px surface gaps between fills, per the mark spec — the gap is the
          card background showing through, not a stroke. */}
      <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md">
        {segments.map((s) => (
          <div
            key={s.key}
            title={`${s.label} · ${s.share.toFixed(1)}%`}
            className="flex items-center justify-center overflow-hidden first:rounded-l-md last:rounded-r-md"
            style={{ width: `${s.share}%`, background: s.color }}
          >
            {s.share > 11 && (
              <span
                className="px-1 font-mono text-[10px] tabular-nums"
                style={{ color: "var(--card)" }}
              >
                {s.share.toFixed(0)}%
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <span
            key={s.key}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              aria-hidden
              className="inline-block size-2 rounded-[2px]"
              style={{ background: s.color }}
            />
            <span className="text-foreground">{s.label}</span>
            <Pct value={s.share} signed={false} className="text-[10.5px]" />
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── drift vs target ──────────────────────────────────────────────────────

const DRIFT_CONFIG: ChartConfig = {
  drift: { label: "Drift", color: "var(--primary)" },
}

/**
 * Diverging bars centred on zero, with the ±threshold drawn as the decision
 * line. Direction (over- vs under-weight) is carried by geometry, not hue:
 * emerald/rose already mean gain/loss everywhere else on this page, and
 * neither over- nor under-weight is "bad" in that sense. Hue is spent on the
 * one distinction that drives a decision — breached the band, or didn't.
 */
export function DriftChart({ rows }: { rows: DriftRow[] }) {
  // Round the domain out to a whole number of percentage points, or the axis
  // renders float ticks like "+1.4775921472281".
  // Headroom past the widest bar so its direct label has somewhere to sit;
  // without it the largest — the one that matters — is the one that clips.
  const widest = Math.max(...rows.map((r) => Math.abs(r.drift)))
  const bound = Math.max(DRIFT_THRESHOLD_PP + 3, Math.ceil(widest) + 4)
  const ticks = [-bound, -DRIFT_THRESHOLD_PP, 0, DRIFT_THRESHOLD_PP, bound]
  return (
    <ChartContainer config={DRIFT_CONFIG} className="h-40 w-full">
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 28, left: 0, bottom: 0 }}
        barCategoryGap={6}
      >
        <CartesianGrid horizontal={false} strokeDasharray="2 4" />
        <XAxis
          type="number"
          domain={[-bound, bound]}
          ticks={ticks}
          tickLine={false}
          axisLine={false}
          fontSize={10}
          tickMargin={4}
          tickFormatter={(v) => {
            const n = v as number
            if (n === 0) return "0"
            return `${n > 0 ? "+" : MINUS}${Math.abs(n)}pp`
          }}
        />
        <YAxis
          type="category"
          dataKey="ticker"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          width={58}
        />
        <ReferenceLine
          x={0}
          stroke="var(--muted-foreground)"
          strokeOpacity={0.5}
        />
        {/* The decision lines. Labelled by the axis, so no duplicate text. */}
        <ReferenceLine
          x={DRIFT_THRESHOLD_PP}
          stroke="var(--border)"
          strokeDasharray="3 3"
        />
        <ReferenceLine
          x={-DRIFT_THRESHOLD_PP}
          stroke="var(--border)"
          strokeDasharray="3 3"
        />
        <Bar dataKey="drift" radius={2} barSize={11}>
          {/* Selective direct labels: the magnitude is the point, and reading
              it off the axis for an 11px bar is guesswork. */}
          <LabelList
            dataKey="drift"
            position="right"
            fontSize={10}
            className="fill-muted-foreground"
            formatter={(v: unknown) => {
              const n = Number(v)
              return `${n > 0 ? "+" : MINUS}${Math.abs(n).toFixed(1)}`
            }}
          />
          {rows.map((r) => (
            <Cell
              key={r.ticker}
              fill={
                Math.abs(r.drift) > DRIFT_THRESHOLD_PP
                  ? "var(--primary)"
                  : "var(--muted-foreground)"
              }
              fillOpacity={Math.abs(r.drift) > DRIFT_THRESHOLD_PP ? 0.9 : 0.3}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/**
 * The same information as one line of text. On a portfolio held on target by
 * automatic contributions this is the honest default: five bars all sitting on
 * zero is a chart that reports nothing.
 */
export function DriftStatusLine({ totals }: { totals: SleeveTotals }) {
  if (totals.worstDrift == null) {
    return (
      <span className="text-muted-foreground text-xs">No target policy</span>
    )
  }
  const fires = totals.worstDrift > DRIFT_THRESHOLD_PP
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        fires ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"
      )}
    >
      <span aria-hidden>{fires ? "▲" : "●"}</span>
      {fires ? "Rebalance" : "On target"}
      <span className="font-mono tabular-nums">
        worst {totals.worstDrift.toFixed(1)}pp
      </span>
    </span>
  )
}

// ─── contribution room ────────────────────────────────────────────────────

/**
 * Meter, not a two-slice donut: one ratio against one limit. The pace marker
 * is the second question a limit always raises — not "how much is in" but
 * "am I on track to fill it".
 */
export function ContributionMeter({
  room,
  size = "md",
}: {
  room: ContributionRoom
  size?: "sm" | "md"
}) {
  const pct = (room.used / room.limit) * 100
  const ahead = pct / 100 >= YEAR_ELAPSED
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn(size === "md" ? "text-[13px]" : "text-xs")}>
          {room.label}
        </span>
        <span className="flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
          <Money value={room.used} maximumFractionDigits={0} />
          <span className="text-muted-foreground">
            / {formatMoney(room.limit, { maximumFractionDigits: 0 })}
          </span>
        </span>
      </div>
      <div className="relative">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/80"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        {/* Pace marker: where a steady-contribution year would be today. */}
        <span
          aria-hidden
          className="absolute -top-[3px] h-[14px] w-px bg-foreground/45"
          style={{ left: `${YEAR_ELAPSED * 100}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {formatMoney(room.limit - room.used, { maximumFractionDigits: 0 })}{" "}
          room left · {room.cadence}
        </span>
        <span className={ahead ? "text-emerald-600 dark:text-emerald-400" : ""}>
          {room.projectedFullBy
            ? `maxes ${room.projectedFullBy}`
            : "will fall short"}
        </span>
      </div>
    </div>
  )
}

// ─── cash & margin ────────────────────────────────────────────────────────

/**
 * A drawn margin balance inside an interest-free allowance is not debt, and
 * rendering it in the liability tone would be a lie the rest of the page then
 * has to argue with. Neutral track, explicit allowance.
 */
export function MarginMeter({
  drawn,
  tranche,
}: {
  drawn: number
  tranche: number
}) {
  const used = Math.min(Math.abs(drawn), tranche)
  const over = Math.max(0, Math.abs(drawn) - tranche)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px]">Margin drawn</span>
        <span className="font-mono text-xs tabular-nums">
          {formatMoney(Math.abs(drawn), { maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-l-full bg-muted-foreground/45"
          style={{ width: `${(used / tranche) * 100}%` }}
        />
        {over > 0 && (
          <div
            className="h-full bg-rose-500/80"
            style={{ width: `${(over / tranche) * 100}%` }}
          />
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {over > 0 ? (
          <span className="text-rose-600 dark:text-rose-400">
            {formatMoney(over, { maximumFractionDigits: 2 })} past the
            interest-free allowance
          </span>
        ) : (
          <>
            within the {formatMoney(tranche, { maximumFractionDigits: 0 })}{" "}
            interest-free allowance · not debt
          </>
        )}
      </div>
    </div>
  )
}

// ─── holdings table ───────────────────────────────────────────────────────

export function HoldingsHeader({ dense }: { dense?: boolean }) {
  return (
    <div
      className={cn(
        "grid items-center gap-x-3 border-b px-4 text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]",
        dense ? "py-1.5" : "py-2",
        "grid-cols-[minmax(0,2.2fr)_5rem_5rem_6rem_6rem_7.5rem_5.5rem]"
      )}
    >
      <span>Position</span>
      <span className="text-right">Units</span>
      <span className="text-right">Price</span>
      <span className="text-right">Cost</span>
      <span className="text-right">Value</span>
      <span className="text-right">Unrealized</span>
      <span className="text-right">Weight</span>
    </div>
  )
}

export function HoldingRow({
  h,
  weight,
  topWeight,
  dense,
}: {
  h: Holding
  weight: number
  topWeight: number
  dense?: boolean
}) {
  const gain = h.value - h.cost
  const pct = h.cost ? (gain / h.cost) * 100 : 0
  return (
    <div
      className={cn(
        "grid items-center gap-x-3 px-4 transition-colors hover:bg-accent/40",
        dense ? "py-1" : "py-1.5",
        "grid-cols-[minmax(0,2.2fr)_5rem_5rem_6rem_6rem_7.5rem_5.5rem]"
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-medium font-mono text-[13px]">{h.ticker}</span>
        <span className="truncate text-muted-foreground text-xs">{h.name}</span>
      </div>
      <span className="text-right">
        <Units value={h.units} />
      </span>
      <Money
        value={h.price}
        className="text-right text-xs text-muted-foreground"
      />
      <Money
        value={h.cost}
        className="text-right text-xs"
        maximumFractionDigits={0}
      />
      <Money
        value={h.value}
        className="text-right text-[13px]"
        maximumFractionDigits={0}
      />
      <span className="text-right">
        <Gain value={gain} pct={pct} className="justify-end text-xs" />
      </span>
      <span className="flex items-center justify-end gap-2">
        <Pct
          value={weight}
          signed={false}
          className="text-[11px] text-muted-foreground"
        />
        <span className="h-[5px] w-9 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-muted-foreground/40"
            style={{ width: `${Math.max(3, (weight / topWeight) * 100)}%` }}
          />
        </span>
      </span>
    </div>
  )
}

export function ClosedDisclosure({ closed }: { closed: Holding[] }) {
  const [open, setOpen] = React.useState(false)
  if (closed.length === 0) return null
  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden className="font-mono">
          {open ? "−" : "+"}
        </span>
        {closed.length} closed {closed.length === 1 ? "position" : "positions"}
        <span className="text-muted-foreground/70">
          · {closed.map((c) => c.ticker).join(", ")}
        </span>
      </button>
      {open && (
        <div className="pb-1">
          {closed.map((c) => (
            <div
              key={c.ticker}
              className="grid grid-cols-[minmax(0,2.2fr)_auto] items-center gap-x-3 px-4 py-1 text-muted-foreground"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="font-mono text-[13px] line-through">
                  {c.ticker}
                </span>
                <span className="truncate text-xs">{c.name}</span>
              </div>
              <span className="text-[11px]">sold out</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── shared header scaffolding ────────────────────────────────────────────

export function TaxChip({ tax }: { tax: Sleeve["tax"] }) {
  const map: Record<Sleeve["tax"], string> = {
    roth: "Roth",
    traditional: "Pre-tax",
    hsa: "Triple tax-free",
    taxable: "Taxable",
    "401k": "Pre-tax",
  }
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tracking-[0.03em]">
      {map[tax]}
    </span>
  )
}

export function HoverDateCaption({
  hover,
  fallback,
}: {
  hover: SeriesPoint | null
  fallback: string
}) {
  return (
    <div className="mt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
      {hover ? formatChartDate(hover.date.slice(0, 7), "month") : fallback}
    </div>
  )
}
