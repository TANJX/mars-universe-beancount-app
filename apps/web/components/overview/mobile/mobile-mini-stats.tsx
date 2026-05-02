"use client"

import { Money } from "@/components/primitives/money"

interface MobileMiniStatsProps {
  income: number
  expenses: number
}

export function MobileMiniStats({ income, expenses }: MobileMiniStatsProps) {
  return (
    <section className="grid grid-cols-2 gap-2.5 px-5">
      <Tile label="In" value={income} tone="pos" />
      <Tile label="Out" value={-Math.abs(expenses)} tone="neg" />
    </section>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "pos" | "neg"
}) {
  return (
    <div className="rounded-[10px] border bg-card px-3.5 py-3">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </div>
      <Money value={value} tone={tone} className="text-lg font-medium" />
    </div>
  )
}
