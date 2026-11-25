"use client"
// Small recharts pieces for the dashboard: a pace chart (cumulative month vs
// usual) and an area sparkline. Colors come from globals.css tokens only.
import * as React from "react"
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts"

export const TONE_STROKE = {
  neutral: "var(--primary)",
  pos: "var(--color-emerald-500)",
  warn: "var(--runway-warn)",
  crit: "var(--runway-crit)",
} as const

/** Month-to-date cumulative spend (solid) against the usual month (dashed). */
export function PaceLines({
  mtd,
  usual,
  height,
}: {
  mtd: number[]
  usual: number[]
  height: number
}) {
  const days = Math.max(usual.length, mtd.length)
  const data = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    usual: i < usual.length ? usual[i] : undefined,
    mtd: i < mtd.length ? mtd[i] : undefined,
  }))
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 6, right: 4, bottom: 0, left: 4 }}
        >
          <XAxis dataKey="day" hide />
          <YAxis hide domain={[0, "dataMax"]} />
          <Line
            dataKey="usual"
            stroke="var(--muted-foreground)"
            strokeOpacity={0.5}
            strokeDasharray="3 3"
            dot={false}
            strokeWidth={1.25}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            dataKey="mtd"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Area sparkline over plain values. */
export function Sparkline({
  values,
  height = 40,
  color = TONE_STROKE.neutral,
}: {
  values: number[]
  height?: number
  color?: string
}) {
  const id = `dash-spark-${React.useId().replace(/:/g, "")}`
  const data = values.map((v, i) => ({ i, v }))
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <AreaChart
          data={data}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            dataKey="v"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#${id})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Numbers out of a bound spark value: an array of numbers, or of objects read
 * at `field`. Non-finite entries are dropped.
 */
export function sparkValues(raw: unknown, field?: string): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const item of raw) {
    const v =
      typeof item === "number"
        ? item
        : item && typeof item === "object" && field
          ? (item as Record<string, unknown>)[field]
          : undefined
    if (typeof v === "number" && Number.isFinite(v)) out.push(v)
  }
  return out
}
