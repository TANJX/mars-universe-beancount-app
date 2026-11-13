"use client"

// Scenarios side by side: a net-worth overlay (neutral lines; scenarios
// are not categorical identities, so dash pattern and a direct label carry
// identity) and the comparison table. Clicking a column switches to it.

import { ArrowUp } from "lucide-react"
import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { axisMoney, niceTicks } from "@/components/fire/axis"
import { SectionCard, usd, usdShort } from "@/components/fire/controls"
import { ClientOnly } from "@/components/primitives/client-only"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { avgTakeHome } from "@/lib/runway/engine"
import type { RunwayResult } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { AXIS, monthLabel, monthTick, monthTicks } from "./chart-utils"
import type { ScenarioOption } from "./scenario-bar"

const OVERLAY_DASH = ["6 3", "2 3", "8 3 2 3"]
const CONFIG: ChartConfig = {}

export function ScenarioNetWorthChart({
  scenarios,
  results,
  activeId,
}: {
  scenarios: ScenarioOption[]
  results: Record<string, RunwayResult>
  activeId: string
}) {
  const ordered = [
    ...scenarios.filter((s) => s.id !== activeId),
    ...scenarios.filter((s) => s.id === activeId),
  ]
  const data = React.useMemo(() => {
    const base = results[scenarios[0]?.id ?? ""]?.rows ?? []
    return base.map((r, i) => {
      const d: Record<string, unknown> = { month: r.month }
      for (const s of scenarios)
        d[s.id] = results[s.id]?.rows[i]?.netWorth ?? null
      return d
    })
  }, [results, scenarios])
  const y = React.useMemo(() => {
    let lo = Number.POSITIVE_INFINITY
    let hi = 0
    for (const d of data)
      for (const s of scenarios) {
        const v = d[s.id] as number | null
        if (v == null) continue
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    const t = niceTicks(hi * 1.02 || 1, undefined, 5)
    const step = t.ticks[1] ?? t.max
    const floor = Math.max(0, Math.floor(lo / step) * step)
    return { min: floor, max: t.max, ticks: t.ticks.filter((v) => v >= floor) }
  }, [data, scenarios])
  const dashOf = (id: string) => {
    const others = scenarios.filter((s) => s.id !== activeId)
    const k = others.findIndex((s) => s.id === id)
    return OVERLAY_DASH[k % OVERLAY_DASH.length]
  }
  const months = data.map((d) => String(d.month))
  const xTicks = monthTicks(months)
  const firstMonth = months[0] ?? ""
  const last = data.at(-1)

  return (
    <ClientOnly fallback={<Skeleton className="h-40 w-full" />}>
      <ChartContainer
        config={CONFIG}
        className="aspect-auto h-40 w-full"
        role="img"
        aria-label={`Net worth by scenario. ${scenarios
          .map(
            (s) =>
              `${s.label} ends at ${usd(results[s.id]?.rows.at(-1)?.netWorth ?? 0)}`
          )
          .join("; ")}.`}
      >
        <LineChart
          data={data}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
          accessibilityLayer
        >
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
            tickFormatter={(v) => axisMoney(v as number)}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }}
            content={
              <CompareTooltip scenarios={scenarios} activeId={activeId} />
            }
          />
          {ordered.map((s) => {
            const active = s.id === activeId
            return (
              <Line
                key={s.id}
                dataKey={s.id}
                type="monotone"
                stroke={
                  active ? "var(--foreground)" : "var(--muted-foreground)"
                }
                strokeWidth={active ? 2 : 1.25}
                strokeDasharray={active ? undefined : dashOf(s.id)}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            )
          })}
        </LineChart>
      </ChartContainer>
      {/* Labels sit under the plot, not at line ends: the lines finish
          close together and end labels would print over each other. */}
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 pt-1 text-[10.5px]">
        {scenarios.map((s) => {
          const active = s.id === activeId
          const end = last?.[s.id] as number | undefined
          return (
            <span key={s.id} className="flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden="true">
                <line
                  x1="0"
                  x2="14"
                  y1="2"
                  y2="2"
                  stroke={
                    active ? "var(--foreground)" : "var(--muted-foreground)"
                  }
                  strokeWidth={active ? 2 : 1.25}
                  strokeDasharray={active ? undefined : dashOf(s.id)}
                />
              </svg>
              <span className={active ? "" : "text-muted-foreground"}>
                {s.label}
              </span>
              {end != null ? (
                <span className="font-mono text-muted-foreground tabular-nums">
                  {usdShort(end)}
                </span>
              ) : null}
            </span>
          )
        })}
      </div>
    </ClientOnly>
  )
}

function CompareTooltip({
  active,
  payload,
  scenarios,
  activeId,
}: {
  active?: boolean
  payload?: Array<{ payload?: Record<string, unknown> }>
  scenarios: ScenarioOption[]
  activeId: string
}) {
  const d = payload?.[0]?.payload
  if (!active || !d) return null
  const list = [
    ...scenarios.filter((s) => s.id === activeId),
    ...scenarios.filter((s) => s.id !== activeId),
  ]
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{monthLabel(String(d.month))}</div>
      {list.map((s) => (
        <div key={s.id} className="flex justify-between gap-4">
          <span className={s.id === activeId ? "" : "text-muted-foreground"}>
            {s.label}
          </span>
          <span className="font-mono tabular-nums">
            {usd((d[s.id] as number) ?? 0)}
          </span>
        </div>
      ))}
    </div>
  )
}

interface MetricRow {
  label: string
  get: (r: RunwayResult) => number | null
  text?: (r: RunwayResult) => string
  /** Higher is better (for the best-value marker); null = no marker. */
  better: "high" | "low" | null
  /** Shown only when some scenario has a value for it. */
  optional?: boolean
}

/** Contributions above an annual limit, summed over years and accounts. */
function excessTotal(r: RunwayResult): number {
  let total = 0
  for (const byAccount of Object.values(r.pools))
    for (const pool of Object.values(byAccount)) total += pool.excess
  return total
}

export function ScenarioCompare({
  scenarios,
  results,
  activeId,
  onSelect,
}: {
  scenarios: ScenarioOption[]
  results: Record<string, RunwayResult>
  activeId: string
  onSelect: (id: string) => void
}) {
  const first = results[scenarios[0]?.id ?? ""]
  const end = first?.rows.at(-1)?.month ?? ""
  const startYear = Number((first?.rows[0]?.month ?? "2000").slice(0, 4))
  const avgYear = String(startYear + 1)
  const all: MetricRow[] = [
    {
      label: `Net worth ${end ? monthLabel(end) : ""}`,
      get: (r) => r.rows.at(-1)?.netWorth ?? 0,
      better: "high",
    },
    {
      label: "Cash-like left",
      get: (r) => r.rows.at(-1)?.cash ?? 0,
      better: null,
    },
    {
      label: "Invested",
      get: (r) => r.rows.at(-1)?.invested ?? 0,
      better: "high",
    },
    {
      label: "401k balance",
      get: (r) => r.rows.at(-1)?.k401 ?? 0,
      better: "high",
    },
    { label: "401k contributed", get: (r) => r.k401Contributed, better: null },
    {
      label: "HSA contributed",
      get: (r) => r.hsaContributed,
      better: null,
      optional: true,
    },
    {
      label: "IRA contributed",
      get: (r) => r.iraContributed,
      better: null,
      optional: true,
    },
    {
      label: "Over a contribution limit",
      get: excessTotal,
      better: "low",
      optional: true,
    },
    { label: "Employer match", get: (r) => r.matchTotal, better: "high" },
    {
      label: `Avg monthly take-home ${avgYear}`,
      get: (r) => avgTakeHome(r, avgYear),
      better: "high",
    },
    {
      label: "Shortfall from reserve",
      get: (r) => r.shortfallTotal,
      better: "low",
    },
    { label: "Moved to core", get: (r) => r.movedToCore, better: "high" },
    {
      label: "Unvested match forfeited",
      get: () => null,
      text: (r) =>
        r.forfeitMonth
          ? `Yes, ${monthLabel(r.forfeitMonth)} (${usd(r.forfeited)})`
          : "No",
      better: null,
    },
  ]
  const metrics = all.filter(
    (m) =>
      !m.optional ||
      scenarios.some((s) => {
        const r = results[s.id]
        return r ? Math.abs(m.get(r) ?? 0) >= 0.5 : false
      })
  )

  return (
    <SectionCard
      title="Scenario comparison"
      hint="Every job scenario on the current inputs. Click a column to switch to it."
    >
      <div className="flex flex-col gap-3">
        <ScenarioNetWorthChart
          scenarios={scenarios}
          results={results}
          activeId={activeId}
        />
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[28rem] border-collapse text-xs">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 bg-card py-1.5 pr-3 text-left font-normal text-muted-foreground">
                  <span className="sr-only">Metric</span>
                </th>
                {scenarios.map((s) => (
                  <th
                    key={s.id}
                    className={cn(
                      "px-2 py-1 text-right font-medium",
                      s.id === activeId && "bg-muted/50"
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={s.id === activeId}
                      onClick={() => onSelect(s.id)}
                      className="rounded-sm px-1 py-0.5 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[pressed=false]:text-muted-foreground"
                    >
                      {s.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => {
                const vals = scenarios.map((s) => {
                  const r = results[s.id]
                  return r ? m.get(r) : null
                })
                const nums = vals.filter((v): v is number => v != null)
                const best =
                  m.better &&
                  nums.length > 1 &&
                  new Set(nums.map(Math.round)).size > 1
                    ? m.better === "high"
                      ? Math.max(...nums)
                      : Math.min(...nums)
                    : null
                return (
                  <tr key={m.label} className="border-b last:border-0">
                    <td className="sticky left-0 bg-card py-1.5 pr-3 text-muted-foreground">
                      {m.label}
                    </td>
                    {scenarios.map((s, i) => {
                      const r = results[s.id]
                      const v = vals[i]
                      const isBest = best != null && v === best
                      return (
                        <td
                          key={s.id}
                          className={cn(
                            "px-2 py-1.5 text-right font-mono tabular-nums",
                            s.id === activeId && "bg-muted/50",
                            isBest && "font-medium"
                          )}
                        >
                          {isBest ? (
                            <ArrowUp
                              size={10}
                              className="mr-0.5 inline text-muted-foreground"
                              aria-label="best"
                            />
                          ) : null}
                          {r ? (m.text ? m.text(r) : usd(v ?? 0)) : "–"}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  )
}
