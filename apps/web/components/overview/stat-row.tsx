import { Card } from "@/components/ui/card"
import { StatTile } from "@/components/overview/stat-tile"
import type { SeriesPoint } from "@/lib/types/views"

interface StatRowProps {
  income: number
  incomeSeries: SeriesPoint[]
  expenses: number
  expensesSeries: SeriesPoint[]
  savings: number
  savingsSeries: SeriesPoint[]
  savingsRate: number
}

export function StatRow(props: StatRowProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card className="gap-0 overflow-visible p-0">
        <StatTile
          label="Income"
          amount={props.income}
          series={props.incomeSeries}
          tone="pos"
        />
      </Card>
      <Card className="gap-0 overflow-visible p-0">
        <StatTile
          label="Expenses"
          amount={-Math.abs(props.expenses)}
          series={props.expensesSeries}
          tone="neg"
        />
      </Card>
      <Card className="gap-0 overflow-visible p-0">
        <StatTile
          label="Net savings"
          amount={props.savings}
          series={props.savingsSeries}
          tone="pos"
          pct={props.savingsRate}
        />
      </Card>
    </div>
  )
}
