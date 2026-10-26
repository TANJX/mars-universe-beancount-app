"use client"

// Saved scenarios: save the current plan under a name, load one back, and pick
// up to three to overlay on the chart and compare in a table.

import { Trash2 } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import type { MonteCarlo } from "@/lib/fire/engine"
import type { Scenario, SimResult } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { pct, SectionCard, usd } from "./controls"

export interface ComparedRow {
  id: string
  name: string
  mode: string
  tier: string
  path: string
  result: SimResult
  mc: MonteCarlo
}

export function ScenariosPanel({
  scenarios,
  activeId,
  compareIds,
  compared,
  current,
  saving,
  onSave,
  onLoad,
  onDelete,
  onToggleCompare,
}: {
  scenarios: Scenario[]
  activeId: string | null
  compareIds: string[]
  compared: ComparedRow[]
  current: ComparedRow
  saving: boolean
  onSave: (name: string, id?: string) => void
  onLoad: (s: Scenario) => void
  onDelete: (id: string) => void
  onToggleCompare: (id: string) => void
}) {
  const active = scenarios.find((s) => s.id === activeId)
  const [name, setName] = React.useState("")
  React.useEffect(() => setName(active?.name ?? ""), [active?.name])

  const rows = [current, ...compared]
  return (
    <SectionCard
      title="Scenarios"
      hint="Saved to plan/fire-scenarios.json in the ledger. Tick up to three to overlay."
    >
      <div className="flex flex-col gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Scenario name"
            placeholder="Name this plan, e.g. Household, partner new job"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 min-w-64 flex-1 rounded-md border bg-transparent px-2.5 outline-none focus:border-ring dark:bg-input/30"
          />
          {active ? (
            <Button
              size="sm"
              variant="outline"
              disabled={saving || !name.trim()}
              onClick={() => onSave(name.trim(), active.id)}
            >
              Update “{active.name}”
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={saving || !name.trim()}
            onClick={() => onSave(name.trim())}
          >
            Save as new
          </Button>
        </div>

        {scenarios.length ? (
          <div className="flex flex-col divide-y">
            {scenarios.map((s) => (
              <div key={s.id} className="flex items-center gap-3 py-1.5">
                <input
                  type="checkbox"
                  aria-label={`Compare ${s.name}`}
                  checked={compareIds.includes(s.id)}
                  disabled={
                    !compareIds.includes(s.id) && compareIds.length >= 3
                  }
                  onChange={() => onToggleCompare(s.id)}
                />
                <button
                  type="button"
                  onClick={() => onLoad(s)}
                  className={cn(
                    "flex-1 text-left hover:underline",
                    s.id === activeId && "font-medium"
                  )}
                >
                  {s.name}
                </button>
                <span className="text-muted-foreground">
                  {s.updatedAt.slice(0, 10)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => onDelete(s.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">No saved scenarios yet.</p>
        )}

        <table className="w-full text-left">
          <thead className="text-muted-foreground">
            <tr className="[&>th]:py-1 [&>th]:pr-3 [&>th]:font-normal">
              <th>Plan</th>
              <th>Mode</th>
              <th>Tier</th>
              <th>Path</th>
              <th className="text-right">Target</th>
              <th className="text-right">Free</th>
              <th className="text-right">MC median</th>
              <th className="text-right">Coast</th>
              <th className="text-right">Lasts</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {rows.map((r, i) => (
              <tr
                key={r.id}
                className={cn(
                  "border-t [&>td]:py-1.5 [&>td]:pr-3",
                  i === 0 && "font-medium"
                )}
              >
                <td className="font-sans">{r.name}</td>
                <td className="font-sans">{r.mode}</td>
                <td className="font-sans">{r.tier}</td>
                <td className="font-sans">{r.path}</td>
                <td className="text-right">{usd(r.result.targetToday)}</td>
                <td className="text-right">{r.result.freeYear ?? "–"}</td>
                <td className="text-right">{r.mc.fiYear.p50 ?? "–"}</td>
                <td className="text-right">{r.result.coastYear ?? "–"}</td>
                <td className="text-right">{pct(r.mc.successRate, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}
