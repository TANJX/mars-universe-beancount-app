"use client"

// The main chart card: one of three views (sleeve balances, cash flow, play
// share) with its legend above and a one-line note below.

import { AlertTriangle } from "lucide-react"

import { InfoTip, Segmented, usd } from "@/components/fire/controls"
import { ClientOnly } from "@/components/primitives/client-only"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { activeJobAt } from "@/lib/runway/jobs"
import {
  SLEEVES,
  type SleeveId,
  sleeveUsed,
  sleeveValue,
} from "@/lib/runway/sleeves"
import type { RunwayInputs, RunwayResult } from "@/lib/runway/types"

import { CashFlowChart, CashFlowLegend } from "./cash-flow-chart"
import { monthLabel, monthRange } from "./chart-utils"
import { firstUnderCap, PlayShareChart } from "./play-share-chart"
import { SleeveAreaChart, SleeveLegend } from "./sleeve-chart"

export type ChartView = "sleeves" | "flow" | "play"

const TITLE: Record<ChartView, string> = {
  sleeves: "Where the money sits",
  flow: "Take-home vs outflows",
  play: "Play sleeve share of investments",
}

const HELP: Record<ChartView, string> = {
  sleeves:
    "Month-end balance of each sleeve, stacked. Card balances are paid off from cash at the start. The reserve keeps earmarks plus the next 12 months of shortfall, so near the end of the horizon it drains down to the earmarks.",
  flow: "Net pay landing each month against spending, the IRA deposit and one-off bills. The hatched part is what pay does not cover; the reserve pays it.",
  play: "Play sleeve divided by everything invested (core, IRA, 401k, HSA, gold, play). It gets no new money, so the share falls as the rest grows.",
}

export function RunwayChartCard({
  result,
  inputs,
  view,
  onViewChange,
  hidden,
  onToggleSleeve,
  onSoloSleeve,
  playCap,
  periodLabel,
}: {
  result: RunwayResult
  inputs: RunwayInputs
  view: ChartView
  onViewChange: (v: ChartView) => void
  hidden: Set<SleeveId>
  onToggleSleeve: (id: SleeveId) => void
  onSoloSleeve: (id: SleeveId) => void
  playCap: number
  periodLabel: string
}) {
  const rows = result.rows
  const last = rows.at(-1)
  const used = SLEEVES.filter((s) => sleeveUsed(rows, s.id)).map((s) => s.id)
  const endValues: Partial<Record<SleeveId, number>> = {}
  if (last) for (const id of used) endValues[id] = sleeveValue(last, id)
  const horizon = rows.length
  // The paying job at the start owns today's unvested match.
  const firstMonth = rows[0]?.month ?? inputs.horizon.start
  const vesting = activeJobAt(inputs.person.jobs, firstMonth)?.vesting ?? null
  const under = firstUnderCap(rows, playCap)

  const label =
    view === "sleeves"
      ? `Stacked sleeve balances, ${periodLabel}. Net worth goes from ${usd(result.startNetWorth)} to ${usd(last?.netWorth ?? 0)}.`
      : view === "flow"
        ? `Monthly take-home against outflows, ${periodLabel}. Take-home falls short in ${result.shortMonths} of ${horizon} months, ${usd(result.shortfallTotal)} in all.`
        : `Play sleeve share of investments, ${periodLabel}, against a ${Math.round(playCap * 100)}% cap. It ends at ${((last?.playShare ?? 0) * 100).toFixed(1)}%.`

  const notes: { text: string; tone?: "amber" | "rose" }[] = []
  if (view === "flow")
    notes.push({
      text: `Take-home falls short in ${result.shortMonths} of ${horizon} months.`,
    })
  if (view === "play")
    notes.push({
      text: under
        ? `Back under the cap in ${monthLabel(under)}.`
        : last &&
            rows[0] &&
            rows[0].playShare > playCap &&
            last.playShare > playCap
          ? `Stays above the cap for all ${horizon} months; no new money goes in.`
          : "Under the cap the whole time.",
    })
  if (result.forfeitMonth && vesting)
    notes.push({
      text: `Leaving in ${monthLabel(result.forfeitMonth)} forfeits ${usd(result.forfeited)} of unvested match (vests ${monthLabel(vesting.date.slice(0, 7))}).`,
      tone: "amber",
    })
  if (result.unfundedMonths.length > 0)
    notes.push({ text: unfundedText(result), tone: "rose" })
  if (result.efDrawn > 0 && result.efDrawnMonth)
    notes.push({
      text: `The reserve runs dry in ${monthLabel(result.efDrawnMonth)}; ${usd(result.efDrawn)} comes out of the emergency fund.`,
      tone: "rose",
    })
  if (result.coreDrawn > 0 && result.coreDrawnMonth)
    notes.push({
      text: `${usd(result.coreDrawn)} is sold from the core index to cover checking, starting ${monthLabel(result.coreDrawnMonth)}.`,
      tone: "rose",
    })

  return (
    <Card className="gap-0 overflow-hidden p-0 xl:min-h-0 xl:flex-1">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 pt-3 pb-2">
        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground text-xs tracking-wide">
          {TITLE[view]}
          <InfoTip label="Chart">{HELP[view]}</InfoTip>
        </span>
        <Segmented<ChartView>
          ariaLabel="Chart"
          value={view}
          onChange={onViewChange}
          options={[
            { value: "sleeves", label: "Sleeves" },
            { value: "flow", label: "Cash flow" },
            { value: "play", label: "Play share" },
          ]}
        />
      </div>
      <div className="px-4 pb-1">
        {view === "sleeves" ? (
          <SleeveLegend
            sleeves={used}
            hidden={hidden}
            onToggle={onToggleSleeve}
            onSolo={onSoloSleeve}
            values={endValues}
            deficit={result.unfundedPeak}
            className="-mx-4 flex-nowrap overflow-x-auto px-4 py-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
          />
        ) : view === "flow" ? (
          <CashFlowLegend />
        ) : null}
      </div>
      <div className="h-[28dvh] px-2 pb-3 md:h-[34dvh] xl:h-auto xl:min-h-56 xl:flex-1">
        <ClientOnly fallback={<Skeleton className="h-full w-full" />}>
          {view === "sleeves" ? (
            <SleeveAreaChart rows={rows} hidden={hidden} ariaLabel={label} />
          ) : view === "flow" ? (
            <CashFlowChart rows={rows} ariaLabel={label} />
          ) : (
            <PlayShareChart rows={rows} cap={playCap} ariaLabel={label} />
          )}
        </ClientOnly>
      </div>
      {notes.length ? (
        <div className="flex flex-col gap-0.5 border-t px-4 py-2 text-xs">
          {notes.map((n) => (
            <span
              key={n.text}
              className={
                n.tone === "rose"
                  ? "flex items-center gap-1.5 text-rose-600 dark:text-rose-400"
                  : n.tone === "amber"
                    ? "flex items-center gap-1.5 text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
              }
            >
              {n.tone ? <AlertTriangle size={12} className="shrink-0" /> : null}
              {n.text}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

/** "Checking goes $7,533 negative (Jan to May 2027): reserve, emergency fund
 * and core are empty." Unfunded months can be split; the range spans them. */
export function unfundedText(result: RunwayResult): string {
  return `Checking goes ${usd(result.unfundedPeak)} negative (${monthRange(result.unfundedMonths)}): reserve, emergency fund and core are empty.`
}
