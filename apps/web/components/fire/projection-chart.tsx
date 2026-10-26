"use client"

// Portfolio vs FI target over time. The subject is the deterministic
// portfolio line (accent); the Monte Carlo 10th to 90th percentile band sits
// behind it as context; the FI target (dashed) and the coast curve (dotted)
// are the two lines the portfolio is racing. Saved scenarios overlay as thin
// neutral lines so a comparison never needs a second chart.

import * as React from "react"
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { ClientOnly } from "@/components/primitives/client-only"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import type { MonteCarlo, TimelineMark } from "@/lib/fire/engine"
import type { Path, Phase, SimResult } from "@/lib/fire/types"

import { usd, usdShort } from "./controls"

const CONFIG: ChartConfig = {
  portfolio: { label: "Portfolio", color: "var(--primary)" },
  target: { label: "FI target", color: "var(--foreground)" },
  coast: { label: "Coast line", color: "var(--muted-foreground)" },
  band: { label: "10th–90th pct", color: "var(--primary)" },
}

/** Round-number ticks, about 8 to 14 of them: recharts' default 5 lands on
 * values like $850k and $1.70M that are hard to read across. */
function niceTicks(max: number): { max: number; ticks: number[] } {
  const steps = [50e3, 100e3, 200e3, 250e3, 500e3, 1e6, 2e6, 5e6]
  const step = steps.find((x) => max / x <= 14) ?? 1e7
  const top = Math.max(step, Math.ceil(max / step) * step)
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step)
  return { max: top, ticks }
}

/** $250k, $1.5M, $2M: no trailing zeros on an axis. */
function axisMoney(v: number): string {
  if (v >= 1e6) return `$${Number((v / 1e6).toFixed(2))}M`
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`
  return `$${v}`
}

const FREE_TAG: Record<Path, string> = {
  normal: "FI",
  coast: "Coast",
  barista: "Barista",
}

const PHASE_TAG: Record<Phase, string> = {
  saving: "",
  coasting: " · coasting",
  barista: " · side income + top-up",
  retired: " · retired",
}

const OVERLAY_DASH = ["6 3", "2 3", "8 3 2 3"]

export interface Overlay {
  name: string
  result: SimResult
}

export function ProjectionChart({
  result,
  mc,
  marks,
  path,
  overlays,
  showBand,
  showEvents,
  primaryBirthYear,
  horizonAge,
}: {
  result: SimResult
  mc: MonteCarlo | null
  marks: TimelineMark[]
  path: Path
  overlays: Overlay[]
  showBand: boolean
  showEvents: boolean
  primaryBirthYear: number
  /** Last age on the x-axis. */
  horizonAge: number
}) {
  // One marker per year; same-year events share it. Labels step down through
  // four rows so neighbouring years (2029, 2031) don't print over each other.
  const eventGroups = React.useMemo(() => {
    const groups: { year: number; labels: string[] }[] = []
    for (const m of marks) {
      const g = groups.at(-1)
      if (g && g.year === m.year) g.labels.push(m.label)
      else groups.push({ year: m.year, labels: [m.label] })
    }
    return groups
  }, [marks])
  const rows = React.useMemo(() => {
    const bands = new Map(mc?.bands.map((b) => [b.year, b]) ?? [])
    // Coast line runs until withdrawals start. The x-axis is a fixed age
    // window, not "FI + 15 years": a window that follows the result makes the
    // whole chart rescale on every edit, so the band and lines look like they
    // move when only the axis did.
    const coastUntil = result.drawYear ?? result.fiYear
    const lastYear = primaryBirthYear + horizonAge
    return result.rows
      .filter((r) => r.year <= lastYear)
      .map((r) => {
        const b = bands.get(r.year)
        const row: Record<string, unknown> = {
          year: r.year,
          age: r.year - primaryBirthYear,
          portfolio: Math.round(r.portfolio),
          target: Math.round(r.target),
          coast:
            r.year <= (coastUntil ?? r.year) ? Math.round(r.coastTarget) : null,
          band: b ? [Math.round(Math.max(0, b.p10)), Math.round(b.p90)] : null,
          phase: r.phase,
          // The snapshot year: today's ledger value and its estimated year-end.
          now: r.baseline ? Math.round(result.nowPortfolio) : null,
          // Event names live in the tooltip: several share a year (a job
          // change and a child, say) and stacked chart labels collide.
          events: marks.filter((e) => e.year === r.year).map((e) => e.label),
        }
        overlays.forEach((o, i) => {
          const x = o.result.rows.find((q) => q.year === r.year)
          row[`ov${i}`] = x ? Math.round(x.portfolio) : null
        })
        return row
      })
  }, [result, mc, overlays, primaryBirthYear, marks, horizonAge])

  // Scale to the FI target, not the portfolio: after FI the mean path keeps
  // compounding for decades and would squash the years that matter. The line
  // runs off the top instead (allowDataOverflow), and the axis only moves
  // when the target itself does.
  const yAxis = React.useMemo(() => {
    let m = 0
    for (const r of rows) m = Math.max(m, r.target as number)
    return niceTicks(m * 1.4)
  }, [rows])

  return (
    <ClientOnly fallback={<Skeleton className="h-full w-full" />}>
      <ChartContainer config={CONFIG} className="h-full min-h-48 w-full">
        <ComposedChart
          data={rows}
          margin={{ top: 18, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis
            dataKey="year"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
            minTickGap={24}
            tickFormatter={(y) => `${y}`}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
            width={56}
            domain={[0, yAxis.max]}
            ticks={yAxis.ticks}
            interval={0}
            allowDataOverflow
            tickFormatter={(v) => axisMoney(v as number)}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--color-portfolio)", strokeOpacity: 0.3 }}
            content={<ProjectionTooltip overlays={overlays} />}
          />
          {showBand ? (
            <Area
              dataKey="band"
              type="monotone"
              stroke="none"
              fill="var(--color-band)"
              fillOpacity={0.12}
              isAnimationActive={false}
              activeDot={false}
            />
          ) : null}
          {overlays.map((o, i) => (
            <Line
              key={o.name}
              dataKey={`ov${i}`}
              type="monotone"
              stroke="var(--muted-foreground)"
              strokeWidth={1.25}
              strokeDasharray={OVERLAY_DASH[i % OVERLAY_DASH.length]}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          <Line
            dataKey="target"
            type="monotone"
            stroke="var(--color-target)"
            strokeWidth={1.25}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="coast"
            type="monotone"
            stroke="var(--color-coast)"
            strokeWidth={1.25}
            strokeDasharray="1 3"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="portfolio"
            type="monotone"
            stroke="var(--color-portfolio)"
            strokeWidth={2.25}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
          {showEvents
            ? eventGroups.map((g, k) => (
                <ReferenceLine
                  key={g.year}
                  x={g.year}
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.35}
                  strokeDasharray="2 3"
                  label={<EventLabel lines={g.labels} row={k % LABEL_ROWS} />}
                />
              ))
            : null}
          {result.freeYear ? (
            <ReferenceLine
              x={result.freeYear}
              stroke="var(--color-portfolio)"
              strokeWidth={1.5}
              label={{
                value: `${FREE_TAG[path]} ${result.freeYear}`,
                position: "top",
                fontSize: 11,
                fill: "var(--color-portfolio)",
              }}
            />
          ) : null}
          {path !== "normal" &&
          result.drawYear &&
          result.drawYear - 1 !== result.freeYear ? (
            <ReferenceLine
              x={result.drawYear}
              stroke="var(--color-portfolio)"
              strokeDasharray="4 3"
              label={{
                value: `Withdraw ${result.drawYear}`,
                position: "top",
                fontSize: 11,
                fill: "var(--color-portfolio)",
              }}
            />
          ) : null}
        </ComposedChart>
      </ChartContainer>
    </ClientOnly>
  )
}

const LABEL_MAX = 16
const LABEL_ROWS = 4

/** Event names at the top of the plot, beside their marker line. recharts
 * injects `viewBox` (the line's x and the plot's top) when cloning it. */
function EventLabel({
  viewBox,
  lines,
  row,
}: {
  viewBox?: { x: number; y: number }
  lines: string[]
  row: number
}) {
  if (!viewBox) return null
  const text = lines.join(" · ")
  // First event plus a count; the full list is in the <title> and the tooltip.
  const first =
    lines[0].length > LABEL_MAX
      ? `${lines[0].slice(0, LABEL_MAX - 1)}…`
      : lines[0]
  const short = lines.length > 1 ? `${first} +${lines.length - 1}` : first
  return (
    <text
      x={viewBox.x + 3}
      y={viewBox.y + 10 + row * 11}
      fontSize={9.5}
      fill="var(--muted-foreground)"
    >
      <title>{text}</title>
      {short}
    </text>
  )
}

function ProjectionTooltip({
  active,
  payload,
  overlays,
}: {
  active?: boolean
  payload?: Array<{ payload?: Record<string, unknown> }>
  overlays: Overlay[]
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  const band = row.band as [number, number] | null
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {String(row.year)} · age {String(row.age)}
        {row.now != null ? " · baseline" : PHASE_TAG[row.phase as Phase]}
      </div>
      {row.now != null ? (
        <div className="flex justify-between gap-4 text-muted-foreground">
          <span>Ledger today</span>
          <span className="font-mono tabular-nums">
            {usd(row.now as number)}
          </span>
        </div>
      ) : null}
      {(row.events as string[]).length ? (
        <div className="text-muted-foreground">
          {(row.events as string[]).join(" · ")}
        </div>
      ) : null}
      <TipRow
        label={row.now != null ? "Est. year-end" : "Portfolio"}
        value={row.portfolio as number}
        strong
      />
      <TipRow label="FI target" value={row.target as number} />
      {row.coast != null ? (
        <TipRow label="Coast line" value={row.coast as number} />
      ) : null}
      {band ? (
        <div className="flex justify-between gap-4 text-muted-foreground">
          <span>10th–90th pct</span>
          <span className="font-mono tabular-nums">
            {usdShort(band[0])} to {usdShort(band[1])}
          </span>
        </div>
      ) : null}
      {overlays.map((o, i) =>
        row[`ov${i}`] != null ? (
          <TipRow key={o.name} label={o.name} value={row[`ov${i}`] as number} />
        ) : null
      )}
    </div>
  )
}

function TipRow({
  label,
  value,
  strong,
}: {
  label: string
  value: number
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="font-mono tabular-nums">{usd(value)}</span>
    </div>
  )
}

export function ProjectionLegend({ showBand }: { showBand: boolean }) {
  const item = (swatch: React.ReactNode, label: string) => (
    <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
      {swatch}
      {label}
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-3.5">
      {item(
        <span
          className="inline-block h-0.5 w-3 rounded"
          style={{ background: "var(--primary)" }}
        />,
        "Portfolio (mean return)"
      )}
      {showBand
        ? item(
            <span
              className="inline-block h-2 w-3 rounded-[2px]"
              style={{ background: "var(--primary)", opacity: 0.18 }}
            />,
            "Monte Carlo 10th–90th"
          )
        : null}
      {item(
        <span className="inline-block h-0 w-3 border-t border-dashed border-foreground" />,
        "FI target"
      )}
      {item(
        <span className="inline-block h-0 w-3 border-t border-dotted border-muted-foreground" />,
        "Coast line"
      )}
    </div>
  )
}
