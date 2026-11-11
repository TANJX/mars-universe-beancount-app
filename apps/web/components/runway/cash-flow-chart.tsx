"use client"

// Does pay cover what goes out? Take-home and outflows side by side each
// month, on one axis. The part of outflows that pay does not cover is
// hatched (a texture, so it never reads as the red play sleeve and survives
// grayscale), and short months get a faint column behind them.

import { AlertTriangle } from "lucide-react"
import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  XAxis,
  YAxis,
} from "recharts"

import { axisMoney, FLOW_STEPS, niceTicks } from "@/components/fire/axis"
import { usd } from "@/components/fire/controls"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import type { MonthRow } from "@/lib/runway/types"

import { AXIS, monthLabel, monthTick, monthTicks } from "./chart-utils"

const CONFIG: ChartConfig = {
  takeHome: { label: "Take-home", color: "var(--flow-in)" },
  covered: { label: "Outflows", color: "var(--flow-out)" },
  short: { label: "Shortfall", color: "var(--shortfall)" },
}

/** 45° hatch for the uncovered part of outflows. */
export function ShortfallHatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect
          width="5"
          height="5"
          fill="color-mix(in oklch, var(--shortfall) 18%, transparent)"
        />
        <line
          x1="0"
          y1="0"
          x2="0"
          y2="5"
          stroke="var(--shortfall)"
          strokeWidth="2"
        />
      </pattern>
    </defs>
  )
}

type ShapeProps = {
  x?: number
  y?: number
  width?: number
  height?: number
  fill?: string
  payload?: { short: number }
}

function segmentPath(props: unknown, round: (p: { short: number }) => boolean) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    fill,
    payload,
  } = props as ShapeProps
  if (height <= 0 || width <= 0) return <g />
  const r = payload && round(payload) ? Math.min(3, width / 2, height) : 0
  const d = r
    ? `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
    : `M${x},${y}H${x + width}V${y + height}H${x}Z`
  return <path d={d} fill={fill} />
}

/** Bar segment with a rounded top: always (take-home, shortfall). */
function RoundedAlways(props: unknown) {
  return segmentPath(props, () => true)
}

/** Covered outflows: rounded only when no shortfall sits on top. */
function RoundedIfCovered(props: unknown) {
  return segmentPath(props, (p) => p.short <= 0)
}

export function CashFlowChart({
  rows,
  ariaLabel,
}: {
  rows: MonthRow[]
  ariaLabel: string
}) {
  const hatchId = `shortfall-hatch-${React.useId().replace(/:/g, "")}`
  const data = React.useMemo(
    () =>
      rows.map((r) => ({
        month: r.month,
        takeHome: Math.max(0, r.takeHome),
        covered: Math.max(0, Math.min(r.outflows, r.takeHome)),
        short: r.shortfall,
        row: r,
      })),
    [rows]
  )
  const months = rows.map((r) => r.month)
  const xTicks = monthTicks(months)
  const firstMonth = months[0] ?? ""
  const y = React.useMemo(() => {
    let max = 0
    for (const r of rows) max = Math.max(max, r.takeHome, r.outflows)
    return niceTicks(max * 1.04 || 1, FLOW_STEPS, 8)
  }, [rows])

  return (
    <ChartContainer
      config={CONFIG}
      className="h-full min-h-40 w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <BarChart
        data={data}
        barCategoryGap="20%"
        barGap={2}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        <ShortfallHatch id={hatchId} />
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
          domain={[0, y.max]}
          ticks={y.ticks}
          interval={0}
          tickFormatter={(v) => axisMoney(v as number)}
        />
        {rows
          .filter((r) => r.shortfall > 0)
          .map((r) => (
            <ReferenceArea
              key={r.month}
              x1={r.month}
              x2={r.month}
              fill="var(--shortfall)"
              fillOpacity={0.05}
              stroke="none"
              ifOverflow="hidden"
            />
          ))}
        <ChartTooltip
          cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
          content={<CashFlowTooltip />}
        />
        <Bar
          dataKey="takeHome"
          stackId="in"
          fill="var(--color-takeHome)"
          maxBarSize={14}
          shape={RoundedAlways}
          isAnimationActive={false}
        />
        <Bar
          dataKey="covered"
          stackId="out"
          fill="var(--color-covered)"
          maxBarSize={14}
          shape={RoundedIfCovered}
          isAnimationActive={false}
        />
        <Bar
          dataKey="short"
          stackId="out"
          fill={`url(#${hatchId})`}
          maxBarSize={14}
          shape={RoundedAlways}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}

export function CashFlowTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload?: { row?: MonthRow } }>
}) {
  const row = payload?.[0]?.payload?.row
  if (!active || !row) return null
  const parts: [string, number][] = [["Spending", row.spendOut]]
  if (row.iraOut) parts.push(["IRA deposit", row.iraOut])
  if (row.hsaOut) parts.push(["HSA deposit", row.hsaOut])
  if (row.taxOut) parts.push(["One-off bills", row.taxOut])
  return (
    <div className="grid min-w-48 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{monthLabel(row.month)}</div>
      <Line label="Take-home" value={row.takeHome} />
      <Line label="Outflows" value={row.outflows} />
      {parts.length > 1
        ? parts.map(([l, v]) => (
            <div
              key={l}
              className="flex justify-between gap-4 pl-3 text-muted-foreground"
            >
              <span>{l}</span>
              <span className="font-mono tabular-nums">{usd(v)}</span>
            </div>
          ))
        : null}
      <div className="mt-0.5 border-t pt-1">
        {row.shortfall > 0 ? (
          <span className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
            <AlertTriangle size={12} className="shrink-0" />
            Short {usd(row.shortfall)}, drawn from the reserve
          </span>
        ) : (
          <span className="text-muted-foreground">
            Covered, {usd(row.takeHome - row.outflows)} to the sleeves
          </span>
        )}
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{usd(value)}</span>
    </div>
  )
}

export function CashFlowLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[10.5px]">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-[2px] bg-[var(--flow-in)]" />
        Take-home
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-[2px] bg-[var(--flow-out)]" />
        Outflows
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="8" height="8" aria-hidden="true" className="rounded-[2px]">
          <ShortfallHatch id="shortfall-hatch-legend" />
          <rect width="8" height="8" fill="url(#shortfall-hatch-legend)" />
        </svg>
        Shortfall
      </span>
    </div>
  )
}
