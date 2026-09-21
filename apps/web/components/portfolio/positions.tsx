"use client"

import * as React from "react"

import { Gain, Pct, TaxChip, Units } from "@/components/portfolio/atoms"
import type { SleeveView } from "@/components/portfolio/derive"
import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import type { PortfolioHolding } from "@/lib/fava/schemas"
import { formatMoney } from "@/lib/format"
import { cn } from "@/lib/utils"

// One grid definition shared by the column header, the sleeve summary rows and
// the holding rows. This is the alignment fix: a summary row with its own
// track list means opening a sleeve reveals columns that line up with nothing
// above them. All three must report identical column edges.
const POS_GRID =
  "grid grid-cols-[minmax(0,2.4fr)_4.5rem_5rem_5.5rem_6rem_7rem_5rem] items-center gap-x-3 px-4"

export function PositionsHeader() {
  return (
    <div
      className={cn(
        POS_GRID,
        "border-b py-2 text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]"
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

function WeightCell({ weight, top }: { weight: number; top: number }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <Pct
        value={weight}
        signed={false}
        className="text-[11px] text-muted-foreground"
      />
      <span className="h-[5px] w-9 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-muted-foreground/40"
          style={{ width: `${Math.max(3, (weight / top) * 100)}%` }}
        />
      </span>
    </span>
  )
}

export function SleeveRow({
  view,
  topWeight,
  open,
  onToggle,
}: {
  view: SleeveView
  topWeight: number
  open: boolean
  onToggle: () => void
}) {
  const { sleeve, gain, gainPct, weight } = view
  // Closed positions are hidden, so a sleeve is expandable only when it still
  // holds something.
  const collapsed = sleeve.holdings.length === 0
  // Negative brokerage cash inside an interest-free allowance is the allowance
  // in use, not debt. Neutral tone plus this tooltip; never the loss tone.
  const margin =
    sleeve.marginFreeTranche != null && sleeve.cash < 0
      ? `Margin drawn, within the ${formatMoney(sleeve.marginFreeTranche, { maximumFractionDigits: 0 })} interest-free allowance — not debt`
      : undefined
  return (
    <button
      type="button"
      onClick={collapsed ? undefined : onToggle}
      aria-expanded={collapsed ? undefined : open}
      disabled={collapsed}
      className={cn(
        POS_GRID,
        "w-full py-2.5 text-left transition-colors",
        collapsed ? "cursor-default" : "hover:bg-accent/40"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "w-2 shrink-0 font-mono text-[11px] text-muted-foreground",
            collapsed && "opacity-0"
          )}
        >
          {open ? "−" : "+"}
        </span>
        <span
          className={cn("shrink-0 whitespace-nowrap font-medium text-[13px]")}
        >
          {sleeve.label}
        </span>
        <TaxChip tax={sleeve.tax} />
        {sleeve.cash !== 0 && (
          <span
            title={margin}
            className={cn(
              "shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums",
              margin && "underline decoration-dotted underline-offset-2"
            )}
          >
            cash <Money value={sleeve.cash} maximumFractionDigits={0} />
          </span>
        )}
      </span>
      <span />
      <span />
      <Money
        value={sleeve.cost}
        className="text-right text-xs text-muted-foreground"
        maximumFractionDigits={0}
      />
      <Money
        value={sleeve.value}
        className="text-right font-medium text-[13px]"
        maximumFractionDigits={0}
      />
      <span className="text-right">
        <Gain value={gain} pct={gainPct} className="justify-end text-xs" />
      </span>
      <WeightCell weight={weight} top={topWeight} />
    </button>
  )
}

export function HoldingRow({
  h,
  weight,
  topWeight,
}: {
  h: PortfolioHolding
  weight: number
  topWeight: number
}) {
  const gain = h.value - h.cost
  const pct = h.cost ? (gain / h.cost) * 100 : 0
  return (
    <div className={cn(POS_GRID, "py-1 transition-colors hover:bg-accent/40")}>
      {/* pl-[1.375rem] lines the ticker up with the sleeve label above it,
          past the disclosure glyph's width + gap. */}
      <span className="flex min-w-0 items-baseline gap-2 pl-[1.375rem]">
        <span className="shrink-0 font-medium font-mono text-[13px]">
          {h.ticker}
        </span>
        <span className="truncate text-muted-foreground text-xs">{h.name}</span>
      </span>
      <span className="text-right">
        <Units value={h.units} />
      </span>
      <Money
        value={h.price}
        className="text-right text-xs text-muted-foreground"
      />
      <Money
        value={h.cost}
        className="text-right text-xs text-muted-foreground"
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
      <WeightCell weight={weight} top={topWeight} />
    </div>
  )
}

export function PositionsCard({
  views,
  topWeight,
  totalValue,
  positions,
}: {
  views: SleeveView[]
  topWeight: number
  totalValue: number
  positions: number
}) {
  const [open, setOpen] = React.useState<string | null>(null)
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="font-medium text-sm">Positions</span>
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {positions} across {views.length}{" "}
          {views.length === 1 ? "sleeve" : "sleeves"}
        </span>
      </div>
      <PositionsHeader />
      {views.map((view) => {
        const isOpen = open === view.sleeve.id
        return (
          <section key={view.sleeve.id} className="border-b last:border-b-0">
            <SleeveRow
              view={view}
              topWeight={topWeight}
              open={isOpen}
              onToggle={() => setOpen(isOpen ? null : view.sleeve.id)}
            />
            {isOpen && (
              <div className="bg-muted/25 pb-1">
                {view.sleeve.holdings
                  .slice()
                  .sort((a, b) => b.value - a.value)
                  .map((h) => (
                    <HoldingRow
                      key={h.ticker}
                      h={h}
                      weight={totalValue ? (h.value / totalValue) * 100 : 0}
                      topWeight={topWeight}
                    />
                  ))}
              </div>
            )}
          </section>
        )
      })}
    </Card>
  )
}
