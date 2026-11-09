"use client"

// Every row the charts are drawn from, folded by default. Doubles as the
// table view of the charts. Annual mode sums flows per calendar year and
// shows balances at the year's last month.

import { Dot } from "lucide-react"
import * as React from "react"

import { pct, SectionCard, Segmented, usd } from "@/components/fire/controls"
import { SLEEVE_BY_ID, type SleeveId, sleeveValue } from "@/lib/runway/sleeves"
import type { MonthRow } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { monthLabel } from "./chart-utils"

type Mode = "monthly" | "annual"

const FLOW_COLS: { key: keyof MonthRow; label: string }[] = [
  { key: "takeHome", label: "Take-home" },
  { key: "outflows", label: "Outflows" },
  { key: "shortfall", label: "Short" },
  { key: "k401In", label: "401k in" },
  { key: "match", label: "Match" },
  { key: "reserveToCore", label: "To core" },
]
const BAL_COLS: SleeveId[] = [
  "checking",
  "ef",
  "reserve",
  "core",
  "ira",
  "k401",
  "gold",
  "play",
  "other",
]

interface TableRow {
  key: string
  label: string
  row: MonthRow
  flows: Record<string, number>
  events: string[]
  yearStart: boolean
}

function annual(rows: MonthRow[]): TableRow[] {
  const byYear = new Map<string, MonthRow[]>()
  for (const r of rows) {
    const y = r.month.slice(0, 4)
    byYear.set(y, [...(byYear.get(y) ?? []), r])
  }
  return [...byYear.entries()].map(([y, list]) => {
    const flows: Record<string, number> = {}
    for (const c of FLOW_COLS)
      flows[c.key] = list.reduce((a, r) => a + (r[c.key] as number), 0)
    const last = list[list.length - 1]
    return {
      key: y,
      label: list.length < 12 ? `${y} (${list.length} mo)` : y,
      row: last,
      flows,
      events: [...new Set(list.flatMap((r) => r.events))],
      yearStart: false,
    }
  })
}

export function MonthlyTable({
  rows,
  showOther,
}: {
  rows: MonthRow[]
  showOther: boolean
}) {
  const [mode, setMode] = React.useState<Mode>("monthly")
  const cols = BAL_COLS.filter((c) => c !== "other" || showOther)
  const table: TableRow[] =
    mode === "annual"
      ? annual(rows)
      : rows.map((r, i) => ({
          key: r.month,
          label: monthLabel(r.month),
          row: r,
          flows: Object.fromEntries(
            FLOW_COLS.map((c) => [c.key, r[c.key] as number])
          ),
          events: r.events,
          yearStart: i > 0 && r.month.endsWith("-01"),
        }))

  const money = (v: number, short = false) =>
    Math.abs(v) < 0.5 ? (
      <span className="text-muted-foreground">–</span>
    ) : short ? (
      <span className="text-rose-600 dark:text-rose-400">−{usd(v)}</span>
    ) : (
      usd(v)
    )

  return (
    <SectionCard
      title="Monthly detail"
      hint="Every row the charts are drawn from."
    >
      <details className="group">
        <summary className="cursor-pointer list-none text-muted-foreground text-xs hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show {rows.length} months</span>
          <span className="hidden group-open:inline">Hide</span>
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <Segmented<Mode>
            ariaLabel="Table rows"
            value={mode}
            onChange={setMode}
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "annual", label: "Annual" },
            ]}
            className="self-start"
          />
          <div className="-mx-4 max-h-[28rem] overflow-auto px-4">
            <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <Th sticky>{mode === "annual" ? "Year" : "Month"}</Th>
                  {FLOW_COLS.map((c) => (
                    <Th key={c.key}>{c.label}</Th>
                  ))}
                  {cols.map((id, i) => (
                    <Th key={id} divider={i === 0}>
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="size-2 rounded-[2px]"
                          style={{
                            background: `var(${SLEEVE_BY_ID[id].token})`,
                          }}
                        />
                        {SLEEVE_BY_ID[id].short}
                      </span>
                    </Th>
                  ))}
                  <Th divider>Play %</Th>
                  <Th>Net worth</Th>
                </tr>
              </thead>
              <tbody>
                {table.map((t) => (
                  <tr key={t.key} className="hover:bg-muted/40">
                    <td
                      className={cn(
                        "sticky left-0 z-[1] whitespace-nowrap border-b bg-card py-1 pr-3",
                        t.yearStart && "border-t-2 border-t-border"
                      )}
                    >
                      <span className="inline-flex items-center">
                        {t.label}
                        {t.events.length ? (
                          <span title={t.events.join(", ")}>
                            <Dot
                              size={14}
                              className="-my-1 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span className="sr-only">
                              {t.events.join(", ")}
                            </span>
                          </span>
                        ) : null}
                      </span>
                    </td>
                    {FLOW_COLS.map((c) => (
                      <Td key={c.key} yearStart={t.yearStart}>
                        {money(t.flows[c.key], c.key === "shortfall")}
                      </Td>
                    ))}
                    {cols.map((id, i) => (
                      <Td key={id} yearStart={t.yearStart} divider={i === 0}>
                        {money(sleeveValue(t.row, id))}
                      </Td>
                    ))}
                    <Td yearStart={t.yearStart} divider>
                      {pct(t.row.playShare, 1)}
                    </Td>
                    <Td yearStart={t.yearStart}>{usd(t.row.netWorth)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </SectionCard>
  )
}

function Th({
  children,
  sticky,
  divider,
}: {
  children: React.ReactNode
  sticky?: boolean
  divider?: boolean
}) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[2] whitespace-nowrap border-b bg-card px-2 py-1.5 text-right font-normal text-muted-foreground",
        sticky && "left-0 z-[3] pr-3 pl-0 text-left",
        divider && "border-l"
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  yearStart,
  divider,
}: {
  children: React.ReactNode
  yearStart?: boolean
  divider?: boolean
}) {
  return (
    <td
      className={cn(
        "whitespace-nowrap border-b px-2 py-1 text-right font-mono tabular-nums",
        yearStart && "border-t-2 border-t-border",
        divider && "border-l"
      )}
    >
      {children}
    </td>
  )
}
