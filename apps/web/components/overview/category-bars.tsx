import { Panel } from "@/components/overview/panel"
import { Money } from "@/components/primitives/money"
import type { CategoryShare, Period } from "@/lib/types/views"

interface CategoryBarsProps {
  period: Period
  categories: CategoryShare[]
}

export function CategoryBars({ period, categories }: CategoryBarsProps) {
  return (
    <Panel
      title="Where it went"
      action={
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {period.range}
        </span>
      }
    >
      <div className="flex flex-col gap-2.5 px-4 pt-2 pb-3">
        {categories.map((c) => (
          <Row key={c.account} category={c} />
        ))}
      </div>
    </Panel>
  )
}

function Row({ category }: { category: CategoryShare }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{category.segment}</span>
        <Money value={category.amount} className="text-sm" />
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${category.share * 100}%` }}
        />
      </div>
    </div>
  )
}
