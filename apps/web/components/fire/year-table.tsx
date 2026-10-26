"use client"

// Year-by-year rows behind the chart, collapsed by default.

import { activePeople } from "@/lib/fire/engine"
import type { Inputs, SimResult } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { SectionCard, usd } from "./controls"

export function YearTable({
  result,
  inputs,
}: {
  result: SimResult
  inputs: Inputs
}) {
  const names = activePeople(inputs).map((p) => p.name)
  const last = (result.fiYear ?? result.rows.at(-1)?.year ?? 0) + 5
  const rows = result.rows.filter((r) => r.year <= last)
  return (
    <SectionCard
      title="Year by year"
      hint="Real dollars. Saving includes 401k deferrals."
    >
      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Show {rows.length} years
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
                <th className="text-left">Year</th>
                <th className="text-left">Age ({names.join(" / ")})</th>
                <th>Take-home</th>
                <th>Spend</th>
                <th>Kids</th>
                <th>401k</th>
                <th>Saving</th>
                <th>Lumps</th>
                <th>Portfolio</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {rows.map((r) => (
                <tr
                  key={r.year}
                  className={cn(
                    "border-t [&>td]:px-2 [&>td]:py-1",
                    r.year === result.fiYear && "bg-primary/10",
                    r.retired && "text-muted-foreground"
                  )}
                >
                  <td className="text-left">
                    {r.year}
                    {r.baseline ? " (est.)" : r.japan ? " ✈" : ""}
                  </td>
                  <td className="text-left">{r.ages.join(" / ")}</td>
                  <td>{r.takeHome ? usd(r.takeHome) : "–"}</td>
                  <td>{r.spend ? usd(r.spend) : "–"}</td>
                  <td>{r.kidCost ? usd(r.kidCost) : "–"}</td>
                  <td>{r.k401 ? usd(r.k401) : "–"}</td>
                  <td>{usd(r.saving)}</td>
                  <td>{r.lump ? usd(r.lump) : "–"}</td>
                  <td>{usd(r.portfolio)}</td>
                  <td>{usd(r.target)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SectionCard>
  )
}
