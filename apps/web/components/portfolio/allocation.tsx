"use client"

import * as React from "react"

import { Pct, rampAt } from "@/components/portfolio/atoms"
import {
  byAssetClass,
  bySleeve,
  byTicker,
  type ShareRow,
} from "@/components/portfolio/derive"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useResolvedUIConfig } from "@/lib/config"
import type { Portfolio } from "@/lib/fava/schemas"
import { formatMoney } from "@/lib/format"

type Grouping = "class" | "sleeve" | "ticker"

/**
 * Single stacked share bar. Compact, but colour *is* identity for every
 * segment too small to hold an inline label — that is this form's real cost,
 * and why the legend below is mandatory rather than optional.
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
  const segments = [
    ...head.map((r, i) => ({ ...r, color: rampAt(i) })),
    ...(tail.length
      ? [
          {
            key: "__rest",
            label: `${tail.length} others`,
            value: tail.reduce((a, r) => a + r.value, 0),
            share: tail.reduce((a, r) => a + r.share, 0),
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
            title={`${s.label} · ${s.share.toFixed(1)}% · ${formatMoney(s.value, { maximumFractionDigits: 0 })}`}
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
              className="inline-block size-2 shrink-0 rounded-[2px]"
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

export function AllocationCard({ portfolio }: { portfolio: Portfolio }) {
  const { investments } = useResolvedUIConfig()
  const [grouping, setGrouping] = React.useState<Grouping>("class")

  const rows = React.useMemo(() => {
    if (grouping === "sleeve") return bySleeve(portfolio)
    if (grouping === "ticker") return byTicker(portfolio)
    return byAssetClass(portfolio, investments)
  }, [grouping, portfolio, investments])

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Allocation</span>
        <Tabs
          value={grouping}
          onValueChange={(v) => setGrouping(v as Grouping)}
        >
          <TabsList className="h-6">
            <TabsTrigger value="class" className="px-2 text-[11px]">
              Class
            </TabsTrigger>
            <TabsTrigger value="sleeve" className="px-2 text-[11px]">
              Sleeve
            </TabsTrigger>
            <TabsTrigger value="ticker" className="px-2 text-[11px]">
              Ticker
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <StackedShareBar rows={rows} />
    </Card>
  )
}
