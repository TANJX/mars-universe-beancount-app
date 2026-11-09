"use client"

// Stacked sleeve balances, month by month. Color follows the sleeve (never its
// rank or whether it is visible), the y-axis is sized from every sleeve so
// toggling one never rescales the chart, and a surface-colored stroke keeps a
// 1.5px gap between neighboring fills.
//
// Checking can go below zero when reserve, emergency fund and core are all
// empty. The stack clamps it at 0, so that unfunded part is drawn on its own
// as a hatched area under the zero line instead of disappearing.

import { AlertTriangle } from "lucide-react"
import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { axisMoney, niceTicks } from "@/components/fire/axis"
import { pct, usd } from "@/components/fire/controls"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  SLEEVES,
  type SleeveId,
  sleeveUsed,
  sleeveValue,
} from "@/lib/runway/sleeves"
import type { MonthRow } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { ShortfallHatch } from "./cash-flow-chart"
import {
  AXIS,
  monthLabel,
  monthTick,
  monthTicks,
  SLEEVE_CONFIG,
} from "./chart-utils"

const MARKED = new Set(["New job starts", "Match forfeited"])

export function SleeveAreaChart({
  rows,
  hidden,
  events = true,
  ariaLabel,
}: {
  rows: MonthRow[]
  hidden: Set<SleeveId>
  events?: boolean
  ariaLabel: string
}) {
  const used = React.useMemo(
    () => SLEEVES.filter((s) => sleeveUsed(rows, s.id)),
    [rows]
  )
  const data = React.useMemo(
    () =>
      rows.map((r) => {
        const d: Record<string, unknown> = { month: r.month, row: r }
        for (const s of SLEEVES)
          d[s.id] = Math.max(0, Math.round(sleeveValue(r, s.id)))
        d.deficit = Math.min(0, Math.round(r.checking))
        return d
      }),
    [rows]
  )
  const y = React.useMemo(() => {
    let max = 0
    for (const d of data) {
      let t = 0
      for (const s of used) t += d[s.id] as number
      max = Math.max(max, t)
    }
    const top = niceTicks(max * 1.04 || 1, undefined, 8)
    const low = Math.min(0, ...data.map((d) => d.deficit as number))
    if (low >= 0) return { min: 0, ...top }
    // Extend the same grid step below zero, enough to hold the deepest dip.
    const step = top.ticks[1] ?? top.max
    const n = Math.ceil((-low * 1.04) / step)
    const below = Array.from({ length: n }, (_, i) => -(n - i) * step)
    return { min: -n * step, max: top.max, ticks: [...below, ...top.ticks] }
  }, [data, used])
  const hasDeficit = y.min < 0
  const hatchId = `deficit-hatch-${React.useId().replace(/:/g, "")}`
  const months = rows.map((r) => r.month)
  const xTicks = monthTicks(months)
  const firstMonth = months[0] ?? ""
  const visible = used.filter((s) => !hidden.has(s.id))
  const marks = events
    ? rows.flatMap((r) =>
        r.events
          .filter((e) => MARKED.has(e))
          .map((e) => ({ month: r.month, e }))
      )
    : []

  return (
    <ChartContainer
      config={SLEEVE_CONFIG}
      className="h-full min-h-40 w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <AreaChart
        data={data}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        {hasDeficit ? <ShortfallHatch id={hatchId} /> : null}
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="month"
          {...AXIS}
          ticks={xTicks}
          interval={0}
          tickFormatter={(m) => monthTick(String(m), firstMonth)}
        />
        <YAxis
          {...AXIS}
          width={56}
          domain={[y.min, y.max]}
          ticks={y.ticks}
          interval={0}
          tickFormatter={(v) => signedAxisMoney(v as number)}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }}
          content={<SleeveTooltip visible={visible.map((s) => s.id)} />}
        />
        {visible.map((s) => (
          <Area
            key={s.id}
            dataKey={s.id}
            stackId="s"
            type="monotone"
            fill={`var(--color-${s.id})`}
            fillOpacity={1}
            stroke="var(--card)"
            strokeWidth={1.5}
            activeDot={false}
            isAnimationActive={false}
          />
        ))}
        {hasDeficit ? (
          <Area
            dataKey="deficit"
            type="linear"
            baseValue={0}
            fill={`url(#${hatchId})`}
            fillOpacity={1}
            stroke="var(--shortfall)"
            strokeWidth={1}
            activeDot={false}
            isAnimationActive={false}
          />
        ) : null}
        {hasDeficit ? (
          <ReferenceLine y={0} stroke="var(--foreground)" strokeOpacity={0.5} />
        ) : null}
        {marks.map((m) => (
          <ReferenceLine
            key={`${m.month}-${m.e}`}
            x={m.month}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.35}
            strokeDasharray="2 3"
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}

export function SleeveTooltip({
  active,
  payload,
  visible,
}: {
  active?: boolean
  payload?: Array<{ payload?: Record<string, unknown> }>
  visible: SleeveId[]
}) {
  const d = payload?.[0]?.payload
  if (!active || !d) return null
  const row = d.row as MonthRow
  // Top of the stack first, so the list reads in the chart's order.
  const ids = [...visible].reverse()
  return (
    <div className="grid min-w-48 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{monthLabel(row.month)}</span>
        {row.events.length ? (
          <span className="text-muted-foreground">
            {row.events.join(" · ")}
          </span>
        ) : null}
      </div>
      {ids.map((id) => {
        const s = SLEEVES.find((x) => x.id === id)
        if (!s) return null
        return (
          <div key={id} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: `var(--color-${id})` }}
              />
              {s.label}
            </span>
            <span className="font-mono tabular-nums">
              {usd(sleeveValue(row, id))}
            </span>
          </div>
        )
      })}
      {row.checking < -0.005 ? (
        <div className="flex items-center justify-between gap-4 text-rose-600 dark:text-rose-400">
          <span className="flex items-center gap-1.5">
            <AlertTriangle size={11} className="shrink-0" />
            Unfunded (checking below $0)
          </span>
          <span className="font-mono tabular-nums">{usd(row.checking)}</span>
        </div>
      ) : null}
      <div className="mt-0.5 flex justify-between gap-4 border-t pt-1">
        <span className="font-medium">Net worth</span>
        <span className="font-mono font-medium tabular-nums">
          {usd(row.netWorth)}
        </span>
      </div>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <span>Play share</span>
        <span className="font-mono tabular-nums">{pct(row.playShare, 1)}</span>
      </div>
    </div>
  )
}

/** Toggle buttons above the plot. Click hides or shows a sleeve; Alt-click or
 * a long press shows only that sleeve. One sleeve always stays visible. */
export function SleeveLegend({
  sleeves,
  hidden,
  onToggle,
  onSolo,
  values,
  deficit = 0,
  className,
}: {
  sleeves: SleeveId[]
  hidden: Set<SleeveId>
  onToggle: (id: SleeveId) => void
  onSolo: (id: SleeveId) => void
  values?: Partial<Record<SleeveId, number>>
  /** Deepest negative checking balance (positive amount); 0 hides the item. */
  deficit?: number
  className?: string
}) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = React.useRef(false)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  // Legend reads top of stack first, like the tooltip.
  const ordered = SLEEVES.filter((s) => sleeves.includes(s.id)).reverse()
  return (
    <div className={cn("flex gap-x-3.5 gap-y-1", className)}>
      {ordered.map((s) => {
        const off = hidden.has(s.id)
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={!off}
            title="Click to hide or show. Alt-click or long-press to show only this sleeve."
            onPointerDown={(e) => {
              if (e.pointerType === "mouse") return
              longPressed.current = false
              clear()
              timer.current = setTimeout(() => {
                longPressed.current = true
                onSolo(s.id)
              }, 500)
            }}
            onPointerUp={clear}
            onPointerLeave={clear}
            onContextMenu={(e) => {
              if (longPressed.current) e.preventDefault()
            }}
            onClick={(e) => {
              if (longPressed.current) {
                longPressed.current = false
                return
              }
              if (e.altKey) onSolo(s.id)
              else onToggle(s.id)
            }}
            className="relative flex shrink-0 select-none items-center gap-1.5 rounded-sm text-[10.5px] transition-[color,scale] outline-none before:absolute before:-inset-y-2 before:-inset-x-1 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96]"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-[2px]",
                off && "bg-transparent ring-1 ring-current"
              )}
              style={
                off
                  ? { color: `var(${s.token})` }
                  : { background: `var(${s.token})` }
              }
            />
            <span
              className={cn(
                "text-foreground",
                off && "text-muted-foreground/70 line-through"
              )}
            >
              {s.label}
            </span>
            {values?.[s.id] != null ? (
              <span className="font-mono text-muted-foreground tabular-nums">
                {usdCompact(values[s.id] as number)}
              </span>
            ) : null}
          </button>
        )
      })}
      {deficit > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[10.5px]">
          <svg
            width="8"
            height="8"
            aria-hidden="true"
            className="shrink-0 rounded-[2px]"
          >
            <ShortfallHatch id="deficit-hatch-legend" />
            <rect width="8" height="8" fill="url(#deficit-hatch-legend)" />
          </svg>
          <span className="text-foreground">Unfunded</span>
          <span className="font-mono text-muted-foreground tabular-nums">
            {usdCompact(-deficit)}
          </span>
        </span>
      ) : null}
    </div>
  )
}

function signedAxisMoney(v: number): string {
  return v < 0 ? `−${axisMoney(-v)}` : axisMoney(v)
}

function usdCompact(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? "−" : ""
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`
  return `${sign}$${Math.round(a)}`
}
