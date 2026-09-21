import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import type { PortfolioRealizedYear } from "@/lib/fava/schemas"
import { cn } from "@/lib/utils"

// Three tracks shared by the header, the year rows and the lifetime row.
const REALIZED_GRID = "grid grid-cols-[minmax(0,1fr)_8rem_8rem] gap-x-3"

/**
 * Realized gains and dividends by year, with the lifetime total. Both figures
 * arrive already flipped to reader convention — Beancount records them as
 * negative income legs, which would otherwise render every profitable year in
 * the loss tone.
 */
export function RealizedCard({ rows }: { rows: PortfolioRealizedYear[] }) {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div
        className={cn(
          REALIZED_GRID,
          "border-b px-4 py-2 text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]"
        )}
      >
        <span>Realized</span>
        <span className="text-right">Gains</span>
        <span className="text-right">Dividends</span>
      </div>
      {rows.map((r) => (
        <div key={r.year} className={cn(REALIZED_GRID, "px-4 py-1.5")}>
          <span className="font-mono text-[13px] tabular-nums">{r.year}</span>
          <Money value={r.gains} tone="pos" className="text-right text-xs" />
          <Money
            value={r.dividends}
            tone="pos"
            className="text-right text-xs"
          />
        </div>
      ))}
      <div className={cn(REALIZED_GRID, "border-t px-4 py-1.5")}>
        <span className="text-[13px] text-muted-foreground">Lifetime</span>
        <Money
          value={rows.reduce((a, r) => a + r.gains, 0)}
          tone="pos"
          className="text-right text-[13px]"
        />
        <Money
          value={rows.reduce((a, r) => a + r.dividends, 0)}
          tone="pos"
          className="text-right text-[13px]"
        />
      </div>
    </Card>
  )
}
