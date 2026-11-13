"use client"

// The main chart card. Three views share one look and one scrub:
// - Sleeves: balances stacked by family (Cash, Taxable, Retirement, Play,
//   Other), or every sleeve; tap a family or sleeve to fit the scale to it.
// - Cash: checking, emergency fund and reserve on their own scale with the
//   emergency fund target, and each month's net in an aligned panel.
// - Invested: each invested sleeve's share, play on top against its cap.
// Legend values follow the scrub ("At {month}"), events sit on a lane under
// the axis, warnings are dashed lines with a pill, and the notes under the
// chart pin it to their month. A comparison run draws dashed.
// A history range joins past months read from the ledger before the plan:
// drawn solid, the plan lighter after a "Today" divider. Warnings, the
// comparison run and forecast-only rows stay on the plan's months.

import { AlertTriangle } from "lucide-react"
import * as React from "react"

import { InfoTip, Segmented } from "@/components/fire/controls"
import { Card } from "@/components/ui/card"
import {
  type ChartEvent,
  type ChartWarning,
  chartEvents,
  chartWarnings,
  eventText,
  GLYPH_KEY,
  groupSeries,
  money,
  moneyK,
  monthAbbr,
  monthLong,
  monthSpanLabel,
  offsetIndex,
  percent,
  type SeriesDef,
  shareSeries,
  signedK,
  sleeveSeries,
  stackLayers,
  stackTotals,
  withOther,
} from "@/lib/runway/chart"
import type { HistoryRange } from "@/lib/runway/history"
import { activeJobAt } from "@/lib/runway/jobs"
import {
  INVESTED_SLEEVES,
  SLEEVE_BY_ID,
  SLEEVE_GROUPS,
  SLEEVES,
  type SleeveId,
  sleeveUsed,
} from "@/lib/runway/sleeves"
import type { MonthRow, RunwayInputs, RunwayResult } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import {
  ChartFrame,
  DashedLine,
  DashIcon,
  type Geom,
  GlyphIcon,
  HatchSwatch,
  type MarkIds,
  RefLine,
  StackMarks,
  type YAxis,
} from "./runway-chart"
import { useDebouncedText, useScrub } from "./use-scrub"

export type ChartView = "sleeves" | "cash" | "invested"

export interface ChartCompare {
  label: string
  result: RunwayResult
}

/** The history range control and the past months it joins to the plan. */
export interface ChartHistory {
  range: HistoryRange
  onRangeChange: (r: HistoryRange) => void
  /** Actual rows ending the month before the plan starts; empty for none. */
  rows: MonthRow[]
  /** Why a history range draws only the plan (no history, loading). */
  note: string | null
}

const RANGE_OPTIONS: { value: `${HistoryRange}`; label: string }[] = [
  { value: "0", label: "Plan" },
  { value: "12", label: "+12 mo" },
  { value: "24", label: "+24 mo" },
]

const TITLE: Record<ChartView, string> = {
  sleeves: "Where the money sits",
  cash: "Will cash last?",
  invested: "How the invested money is split",
}

const HELP: Record<ChartView, string> = {
  sleeves:
    "Month-end balances, stacked by family (or every sleeve). Tap a family or sleeve to fit the scale to it. Card balances are paid off from cash at the start. The reserve keeps earmarks plus the next 12 months of shortfall, so near the end of the horizon it drains down to the earmarks.",
  cash: "Checking buffer, emergency fund and reserve on their own scale, with the emergency fund target. Under them, each month's take-home minus everything that goes out (spending, IRA and HSA deposits paid from cash, one-off bills). Hatched months are not covered by pay; the reserve pays them.",
  invested:
    "Each invested sleeve as a share of everything invested (core, gold, IRA, 401k, HSA, play). The play sleeve sits on top, so its band reads against the cap line. It gets no new money while above its cap, so its share falls as the rest grows.",
}

const CASH_IDS: SleeveId[] = ["checking", "ef", "reserve"]

// Shared chip look; the pseudo-element grows the hit area on coarse pointers.
const CHIP =
  "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-[11.5px] select-none before:absolute before:inset-x-0 before:-inset-y-1 pointer-coarse:h-8 pointer-coarse:before:-inset-y-1.5"
const CHIP_BUTTON =
  "cursor-pointer outline-none transition-[background-color,border-color,scale] duration-150 ease-out hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96] aria-pressed:border-border aria-pressed:bg-muted motion-reduce:transition-none"

const DockedContext = React.createContext(false)

export function RunwayChartCard({
  result,
  inputs,
  view,
  onViewChange,
  periodLabel,
  condensed,
  compare,
  compareChoices,
  compareId,
  onCompareChange,
  history,
}: {
  result: RunwayResult
  inputs: RunwayInputs
  view: ChartView
  onViewChange: (v: ChartView) => void
  periodLabel: string
  /** Phone, scrolled: plot only, the title doubles as the readout. */
  condensed: boolean
  compare: ChartCompare | null
  /** Scenarios to compare with while on Plan; null hides the control. */
  compareChoices: { id: string; label: string }[] | null
  compareId: string | null
  onCompareChange: (id: string | null) => void
  history: ChartHistory
}) {
  // Forecast rows are `plan`; `rows` is the whole span drawn, history first.
  // Anything indexed against the forecast (warnings, the comparison run)
  // moves right by `off`.
  const plan = result.rows
  const off = history.rows.length
  const rows = off ? [...history.rows, ...plan] : plan
  const months = rows.map((r) => r.month)
  const n = rows.length
  const span = off ? monthSpanLabel([months[0], months[n - 1]]) : periodLabel
  const last = n - 1
  const scrub = useScrub(n)
  const shown = Math.min(scrub.index ?? last, last)
  const [split, setSplit] = React.useState(false)
  const [isolate, setIsolate] = React.useState<string | null>(null)
  const [table, setTable] = React.useState(false)

  const used = SLEEVES.filter((s) => sleeveUsed(rows, s.id)).map((s) => s.id)
  const cmpRows = alignRows(plan, compare?.result.rows ?? null)
  const cmp = compare && cmpRows ? { ...compare, rows: cmpRows } : null
  const cap = inputs.person.playCap
  const efTarget =
    Math.max(0, inputs.person.cash.efMonths) *
    Math.max(0, inputs.person.spendingMonthly)
  const vest =
    activeJobAt(inputs.person.jobs, plan[0]?.month ?? inputs.horizon.start)
      ?.vesting?.date ?? null

  // ---- series for the view
  const groups = SLEEVE_GROUPS.filter((g) =>
    g.members.some((m) => used.includes(m))
  )
  const isoGroup =
    view === "sleeves" ? groups.find((g) => g.id === isolate) : undefined
  let defs: SeriesDef[]
  if (view === "cash")
    defs = CASH_IDS.filter((id) => used.includes(id)).map(sleeveSeries)
  else if (view === "invested")
    defs = INVESTED_SLEEVES.filter((id) => used.includes(id)).map(shareSeries)
  else if (isoGroup)
    defs = isoGroup.members.filter((m) => used.includes(m)).map(sleeveSeries)
  else if (isolate && used.includes(isolate as SleeveId))
    defs = [sleeveSeries(isolate as SleeveId)]
  else
    defs = split
      ? used.map(sleeveSeries)
      : groups.map((g) => groupSeries(g.id, used))
  if (!defs.length && view === "cash") defs = CASH_IDS.map(sleeveSeries)
  const fitted = view === "sleeves" && isolate != null && defs.length > 0
  const fitLabel =
    isoGroup?.label ?? SLEEVE_BY_ID[isolate as SleeveId]?.label ?? ""

  const layers = stackLayers(rows, defs)
  const totals = stackTotals(rows, defs)
  const cmpTotals =
    cmp && view !== "invested" ? stackTotals(cmp.rows, defs) : null
  const showsChecking = defs.some((d) => d.id === "checking" || d.id === "cash")
  const deficit =
    view !== "invested" && showsChecking && rows.some((r) => r.checking < -0.5)
      ? rows.map((r) => Math.min(0, r.checking))
      : null
  const nets = rows.map((r) => r.takeHome - r.outflows)
  const cmpNets = cmp
    ? [
        ...history.rows.map(() => null),
        ...cmp.rows.map((r) => r.takeHome - r.outflows),
      ]
    : null
  /** The comparison run's row for chart month i (none in history). */
  const cmpAt = (i: number) => (cmp && i >= off ? cmp.rows[i - off] : null)

  // ---- events and warnings (the comparison run's own ones are flagged)
  const events = withOther(
    chartEvents(rows, result),
    cmp ? offsetIndex(chartEvents(cmp.rows, cmp.result), off) : null,
    (e) => e.label
  )
  const allWarnings = withOther(
    offsetIndex(chartWarnings(result, vest), off),
    cmp ? offsetIndex(chartWarnings(cmp.result), off) : null,
    (w) => w.short
  )
  const warnings = allWarnings.filter((w) =>
    view === "cash"
      ? w.tone === "rose"
      : view === "invested"
        ? w.tone === "amber"
        : true
  )

  // ---- scale
  const max =
    view === "invested"
      ? 1
      : Math.max(
          0,
          ...totals,
          ...(cmpTotals ?? []),
          view === "cash" ? efTarget : 0
        )
  const min = deficit ? Math.min(0, ...deficit) : 0
  const fmt = view === "invested" ? (v: number) => percent(v, 0) : moneyK

  const marks = (g: Geom, y: YAxis, ids: MarkIds) => (
    <>
      <StackMarks
        g={g}
        y={y}
        layers={layers}
        deficit={deficit}
        hatch={ids.hatch}
        fade={ids.fade}
        compact={condensed}
        compare={
          cmp && cmpTotals
            ? {
                totals: cmpTotals,
                from: off,
                label: cmp.label,
                diff: signedK((cmpTotals.at(-1) ?? 0) - (totals[last] ?? 0)),
              }
            : null
        }
      />
      {view === "cash" && efTarget > 0 ? (
        <RefLine
          g={g}
          yy={y.y(efTarget)}
          label={condensed ? "" : "Emergency fund target"}
          side="start"
        />
      ) : null}
      {view === "invested" ? (
        <>
          <RefLine
            g={g}
            yy={y.y(1 - cap)}
            label={condensed ? "" : `Play cap ${percent(cap, 0)}`}
            side="end"
          />
          {cmp ? (
            <DashedLine
              g={g}
              y={y}
              vals={cmp.rows.map((r) => 1 - r.playShare)}
              from={off}
            />
          ) : null}
        </>
      ) : null}
    </>
  )
  const dots = (i: number, _g: Geom, y: YAxis) => {
    const c = cmpAt(i)
    return view === "invested"
      ? [y.y(1 - rows[i].playShare), ...(c ? [y.y(1 - c.playShare)] : [])]
      : [
          y.y(totals[i]),
          ...(cmpTotals && i >= off ? [y.y(cmpTotals[i - off])] : []),
        ]
  }

  // ---- readout
  const evAt = (i: number) => events.filter((e) => e.i === i)
  const warnAt = (i: number) => allWarnings.filter((w) => w.i === i)
  const tooltip = (i: number, docked: boolean) => {
    const r = rows[i]
    const c = cmpAt(i)
    let body: React.ReactNode
    if (view === "sleeves") {
      const tot = defs.reduce((t, d) => t + d.get(r), 0)
      body = (
        <>
          <TipRows>
            {[...defs].reverse().map((d) => (
              <TipRow
                key={d.id}
                k={d.label}
                swatch={`var(${d.token})`}
                v={money(d.get(r))}
              />
            ))}
          </TipRows>
          {r.checking < -0.5 && showsChecking ? (
            <TipRow k="Checking below $0" v={money(r.checking)} tone="crit" />
          ) : null}
          <TipRow
            total
            k={fitted ? "Total" : "Net worth"}
            v={money(fitted ? tot : r.netWorth)}
          />
          {c && cmp ? (
            <CompareRow
              label={cmp.label}
              value={
                fitted ? defs.reduce((t, d) => t + d.get(c), 0) : c.netWorth
              }
              base={fitted ? tot : r.netWorth}
            />
          ) : null}
        </>
      )
    } else if (view === "cash" && r.actual) {
      const net = r.takeHome - r.outflows
      body = (
        <>
          <TipRows>
            <TipRow k="Take-home" v={money(r.takeHome)} />
            <TipRow k="Spending" v={money(r.spendOut)} />
          </TipRows>
          <TipRow
            total
            k="Net"
            v={money(net)}
            tone={net < -0.5 ? "crit" : undefined}
          />
          <TipRow k="Cash" v={money(r.cash)} />
        </>
      )
    } else if (view === "cash") {
      const bills = inputs.person.oneOffs.filter(
        (o) => o.month === r.month && o.amount !== 0
      )
      const net = r.takeHome - r.outflows
      body = (
        <>
          <TipRows>
            <TipRow k="Take-home" v={money(r.takeHome)} />
            <TipRow k="Spending" v={money(r.spendOut)} />
            {bills.map((o, k) => (
              <TipRow key={k} k={o.label || "Tax due"} v={money(o.amount)} />
            ))}
            {r.iraOut >= 0.5 ? (
              <TipRow k="IRA deposit" v={money(r.iraOut)} />
            ) : null}
            {r.hsaOut >= 0.5 ? (
              <TipRow k="HSA deposit" v={money(r.hsaOut)} />
            ) : null}
          </TipRows>
          <TipRow
            total
            k={net < -0.5 ? "Not covered" : "Left over"}
            v={money(Math.abs(net))}
            tone={net < -0.5 ? "crit" : undefined}
          />
          <TipRow k="Cash" v={money(r.cash)} />
          {c && cmp ? (
            <CompareRow
              label={`${cmp.label} cash`}
              value={c.cash}
              base={r.cash}
            />
          ) : null}
        </>
      )
    } else {
      body = (
        <>
          <TipRows>
            {[...defs].reverse().map((d) => (
              <TipRow
                key={d.id}
                k={d.label}
                swatch={`var(${d.token})`}
                v={
                  docked
                    ? percent(d.get(r))
                    : `${percent(d.get(r))}  ${moneyK(r[d.id as SleeveId])}`
                }
              />
            ))}
          </TipRows>
          <TipRow total k="Invested" v={money(r.invested)} />
          <TipRow
            k={docked ? "Play share" : `Play share (cap ${percent(cap, 0)})`}
            v={percent(r.playShare)}
          />
          {c && cmp ? (
            <TipRow
              dash
              k={`${cmp.label} play share`}
              v={percent(c.playShare)}
            />
          ) : null}
        </>
      )
    }
    return (
      <DockedContext.Provider value={docked}>
        <TipBody
          month={months[i]}
          actual={!!r.actual}
          pinned={scrub.pinned}
          events={evAt(i)}
          warnings={warnAt(i)}
          otherLabel={cmp?.label ?? null}
        >
          {body}
        </TipBody>
      </DockedContext.Provider>
    )
  }

  const at = rows[shown]
  const atNet = at ? at.takeHome - at.outflows : 0
  const summary = !at
    ? ""
    : view === "sleeves"
      ? `Net worth ${moneyK(at.netWorth)}`
      : view === "cash"
        ? `Cash ${moneyK(at.cash)}, ${atNet < -0.5 ? "short" : "left over"} ${moneyK(Math.abs(atNet))}`
        : `Play ${percent(at.playShare)}`
  const live = useDebouncedText(
    scrub.index != null && at
      ? [
          `${monthLong(at.month)}. ${summary}.`,
          ...evAt(shown).map(eventText),
          ...warnAt(shown).map((w) => w.text),
        ].join(" ")
      : ""
  )

  const pastNote = off
    ? ` ${off} months from the ledger come first, then the plan from ${monthLong(plan[0]?.month ?? "")}.`
    : ""
  const ariaLabel =
    (view === "sleeves"
      ? `Stacked balances, ${span}. Net worth goes from ${money(off ? (rows[0]?.netWorth ?? 0) : result.startNetWorth)} to ${money(rows[last]?.netWorth ?? 0)}.`
      : view === "cash"
        ? `Cash balances, ${span}, with each month's net under them. Take-home falls short in ${result.shortMonths} of ${plan.length} planned months.`
        : `Share of invested money by sleeve, ${span}. The play sleeve ends at ${percent(rows[last]?.playShare ?? 0)} against a ${percent(cap, 0)} cap.`) +
    pastNote

  const changeView = (v: ChartView) => {
    setIsolate(null)
    onViewChange(v)
  }
  const fit = (id: string) => setIsolate((cur) => (cur === id ? null : id))

  // ---- legend
  const legendDefs = [...defs].reverse()
  const legend = !at ? null : (
    <div className="flex flex-wrap items-center gap-1 px-3.5 pb-1.5 pointer-coarse:gap-y-2">
      <span className="mr-1.5 inline-flex min-w-[7.5em] items-baseline gap-1 text-[11px] text-muted-foreground">
        At <b className="font-medium text-foreground">{monthLong(at.month)}</b>
      </span>
      {view === "sleeves" && !fitted ? (
        <Segmented<"groups" | "sleeves">
          ariaLabel="Detail"
          value={split ? "sleeves" : "groups"}
          onChange={(v) => setSplit(v === "sleeves")}
          className="mr-1 h-6 pointer-coarse:h-8"
          optionClassName="px-2 text-[11px]"
          options={[
            { value: "groups", label: "Families" },
            { value: "sleeves", label: "All sleeves" },
          ]}
        />
      ) : null}
      {legendDefs.map((d) =>
        view === "sleeves" ? (
          <button
            key={d.id}
            type="button"
            aria-pressed={isolate === d.id}
            title={fitted ? undefined : `Fit the scale to ${d.label}`}
            onClick={() => fit(d.id)}
            className={cn(CHIP, CHIP_BUTTON)}
          >
            <Swatch color={`var(${d.token})`} />
            <span className="text-foreground">{d.label}</span>
            <ChipValue>{moneyK(d.get(at))}</ChipValue>
          </button>
        ) : (
          <span key={d.id} className={CHIP}>
            <Swatch color={`var(${d.token})`} />
            <span className="text-foreground">{d.label}</span>
            <ChipValue>
              {view === "invested" ? percent(d.get(at)) : moneyK(d.get(at))}
            </ChipValue>
          </span>
        )
      )}
      {deficit ? (
        <span className={CHIP}>
          <HatchSwatch />
          <span className="text-foreground">Checking below $0</span>
          <ChipValue>{moneyK(Math.min(0, at.checking))}</ChipValue>
        </span>
      ) : null}
      {view === "cash" && efTarget > 0 ? (
        <span className={CHIP}>
          <RefSwatch />
          <span className="text-foreground">Emergency fund target</span>
          <ChipValue>{moneyK(efTarget)}</ChipValue>
        </span>
      ) : null}
      {view === "invested" ? (
        <span className={CHIP}>
          <RefSwatch />
          <span className="text-foreground">Play cap {percent(cap, 0)}</span>
        </span>
      ) : null}
      {fitted ? (
        <button
          type="button"
          onClick={() => setIsolate(null)}
          className={cn(CHIP, CHIP_BUTTON, "text-muted-foreground")}
        >
          Show all
        </button>
      ) : null}
    </div>
  )

  // ---- event key
  const keyTypes = GLYPH_KEY.filter((k) =>
    events.some((e) => e.type === k.type && !e.other)
  )
  const firstOther = events.find((e) => e.other)
  const eventKey =
    keyTypes.length || firstOther ? (
      <div
        aria-hidden="true"
        className="flex flex-wrap gap-x-3 gap-y-1 px-3.5 pt-0.5 pb-2 text-[11px] text-muted-foreground"
      >
        {keyTypes.map((k) => (
          <span key={k.type} className="inline-flex items-center gap-1.5">
            <GlyphIcon type={k.type} />
            {k.label}
          </span>
        ))}
        {firstOther && cmp ? (
          <span className="inline-flex items-center gap-1.5">
            <GlyphIcon type={firstOther.type} hollow />
            Only in {cmp.label}
          </span>
        ) : null}
      </div>
    ) : null

  // ---- table
  const columns: { h: string; f: (x: MonthRow, i: number) => string }[] =
    view === "sleeves"
      ? [
          ...legendDefs.map((d) => ({
            h: d.label,
            f: (x: MonthRow) => money(d.get(x)),
          })),
          { h: "Net worth", f: (x) => money(x.netWorth) },
          ...(cmp
            ? [
                {
                  h: cmp.label,
                  f: (_x: MonthRow, i: number) => {
                    const c = cmpAt(i)
                    return c ? money(c.netWorth) : ""
                  },
                },
              ]
            : []),
        ]
      : view === "cash"
        ? [
            { h: "Take-home", f: (x) => money(x.takeHome) },
            { h: "Spending", f: (x) => money(x.spendOut) },
            { h: "One-offs", f: (x) => (x.actual ? "" : money(x.taxOut)) },
            { h: "Net", f: (x) => money(x.takeHome - x.outflows) },
            { h: "Checking", f: (x) => money(x.checking) },
            { h: "Emergency fund", f: (x) => money(x.ef) },
            { h: "Reserve", f: (x) => money(x.reserve) },
          ]
        : [
            ...legendDefs.map((d) => ({
              h: d.label,
              f: (x: MonthRow) => percent(d.get(x)),
            })),
            { h: "Invested", f: (x) => money(x.invested) },
            ...(cmp
              ? [
                  {
                    h: `${cmp.label} play`,
                    f: (_x: MonthRow, i: number) => {
                      const c = cmpAt(i)
                      return c ? percent(c.playShare) : ""
                    },
                  },
                ]
              : []),
          ]

  const heights: Record<ChartView, string> = {
    sleeves: "h-[220px] md:h-[300px]",
    cash: "h-[224px] md:h-[276px]",
    invested: "h-[210px] md:h-[280px]",
  }
  const titleText =
    condensed && scrub.index != null && at
      ? `${monthAbbr(at.month)} · ${summary}`
      : TITLE[view]

  return (
    <Card className="gap-0 overflow-hidden p-0 xl:min-h-0 xl:flex-1">
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5",
          condensed ? "px-3 pt-2 pb-0.5" : "px-3.5 pt-3 pb-1.5"
        )}
      >
        <div className="grid min-w-0">
          <h2 className="inline-flex min-w-0 items-center gap-1 font-medium text-muted-foreground text-xs tracking-wide">
            <span className="truncate tabular-nums">{titleText}</span>
            {condensed ? null : (
              <InfoTip label="Chart">
                {HELP[view]}
                {off
                  ? " Months before the Today line are actual month-end balances and flows from the ledger; the plan after it is drawn lighter. Warnings and comparisons cover only the plan."
                  : ""}
              </InfoTip>
            )}
          </h2>
          {condensed ? null : (
            <span className="text-[11px] text-muted-foreground">
              {view === "sleeves"
                ? `Month-end balances, ${span}`
                : view === "cash"
                  ? "Checking, emergency fund and reserve, with each month’s net"
                  : "Core index, gold, retirement accounts and the play sleeve"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cmp && !condensed ? (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] text-foreground/80">
              <DashIcon />
              {cmp.label}
            </span>
          ) : null}
          {compareChoices?.length && !condensed ? (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Compare with
              <select
                value={compareId ?? ""}
                onChange={(e) => onCompareChange(e.target.value || null)}
                className="h-8 rounded-md border bg-background px-1.5 text-base text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-6 md:text-[11px]"
              >
                <option value="">Off</option>
                {compareChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {condensed ? null : (
            <Segmented<`${HistoryRange}`>
              ariaLabel="History"
              value={`${history.range}`}
              onChange={(v) => history.onRangeChange(Number(v) as HistoryRange)}
              className="pointer-coarse:h-9"
              optionClassName="px-2 tabular-nums pointer-coarse:px-2.5"
              options={RANGE_OPTIONS}
            />
          )}
          <Segmented<ChartView>
            ariaLabel="Chart"
            value={view}
            onChange={changeView}
            className="pointer-coarse:h-9"
            optionClassName="pointer-coarse:px-3"
            options={[
              { value: "sleeves", label: "Sleeves" },
              { value: "cash", label: "Cash" },
              { value: "invested", label: "Invested" },
            ]}
          />
        </div>
      </div>
      {condensed ? null : legend}
      {history.note && !condensed ? (
        <p className="px-3.5 pb-1.5 text-[11px] text-muted-foreground">
          {history.note}
        </p>
      ) : null}
      {fitted && !condensed ? (
        <p className="px-3.5 pb-1.5 text-[11px] text-muted-foreground">
          Scale fitted to{" "}
          <b className="font-medium text-foreground">{fitLabel}</b>. Sleeves too
          thin to read in the full stack get room here.
        </p>
      ) : null}
      <div
        className={cn(
          "px-1.5 pb-1",
          condensed
            ? "h-[124px]"
            : cn(heights[view], "xl:h-auto xl:min-h-56 xl:flex-1")
        )}
      >
        <ChartFrame
          months={months}
          compact={condensed}
          max={max}
          min={min}
          domain={view === "invested" ? { lo: 0, hi: 1 } : undefined}
          fmt={fmt}
          marks={marks}
          dots={dots}
          events={events}
          warnings={warnings}
          net={
            view === "cash"
              ? {
                  values: nets,
                  other: cmpNets,
                  label: "Monthly net: take-home minus outflows",
                }
              : null
          }
          split={off}
          scrub={scrub}
          tooltip={tooltip}
          ariaLabel={ariaLabel}
          live={live}
        />
      </div>
      {condensed ? null : (
        <>
          {eventKey}
          <Notes
            warnings={warnings}
            info={
              view === "cash" && result.shortMonths > 0
                ? `Take-home falls short in ${result.shortMonths} of ${plan.length} planned months, ${money(result.shortfallTotal)} in all.`
                : null
            }
            otherLabel={cmp?.label ?? null}
            pinnedIndex={scrub.pinned ? scrub.index : null}
            onPin={scrub.toggle}
          />
          <div className="flex justify-end px-2.5 pb-2">
            <button
              type="button"
              aria-expanded={table}
              onClick={() => setTable((t) => !t)}
              className="relative h-7 rounded-md px-2 text-[11.5px] text-muted-foreground outline-none transition-[color,background-color,scale] duration-150 ease-out before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96] pointer-coarse:h-9 motion-reduce:transition-none"
            >
              {table ? "Hide table" : "Show table"}
            </button>
          </div>
          {table ? (
            <div className="max-h-60 overflow-auto border-t">
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="sticky top-0 bg-card px-2.5 py-1 text-left font-medium text-muted-foreground"
                    >
                      Month
                    </th>
                    {columns.map((c) => (
                      <th
                        key={c.h}
                        scope="col"
                        className="sticky top-0 whitespace-nowrap bg-card px-2.5 py-1 text-right font-medium text-muted-foreground"
                      >
                        {c.h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <React.Fragment key={x.month}>
                      {off && (i === 0 || i === off) ? (
                        <tr className="border-t">
                          <th
                            scope="rowgroup"
                            colSpan={columns.length + 1}
                            className="bg-muted/60 px-2.5 py-0.5 text-left font-medium text-[10.5px] text-muted-foreground"
                          >
                            {i === 0 ? "Actual, from the ledger" : "Plan"}
                          </th>
                        </tr>
                      ) : null}
                      <tr className="border-t">
                        <th
                          scope="row"
                          className="whitespace-nowrap px-2.5 py-1 text-left font-normal"
                        >
                          {monthAbbr(x.month)}
                        </th>
                        {columns.map((c) => (
                          <td
                            key={c.h}
                            className="whitespace-nowrap px-2.5 py-1 text-right font-mono tabular-nums"
                          >
                            {c.f(x, i)}
                          </td>
                        ))}
                      </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

/** Comparison rows matched to the main run by month; null when the runs do
 * not cover the same months. */
function alignRows(
  rows: MonthRow[],
  other: MonthRow[] | null
): MonthRow[] | null {
  if (!other) return null
  const by = new Map(other.map((r) => [r.month, r]))
  const out: MonthRow[] = []
  for (const r of rows) {
    const o = by.get(r.month)
    if (!o) return null
    out.push(o)
  }
  return out
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-[2px]"
      style={{ background: color }}
    />
  )
}

function ChipValue({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-[3em] font-mono text-[11px] text-muted-foreground tabular-nums">
      {children}
    </span>
  )
}

function RefSwatch() {
  return (
    <svg width="12" height="8" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        x2="12"
        y1="4"
        y2="4"
        stroke="var(--foreground)"
        strokeOpacity="0.6"
        strokeDasharray="2 2"
      />
    </svg>
  )
}

function TipBody({
  month,
  actual,
  pinned,
  events,
  warnings,
  otherLabel,
  children,
}: {
  month: string
  /** A past month from the ledger, not the plan. */
  actual: boolean
  pinned: boolean
  events: ChartEvent[]
  warnings: ChartWarning[]
  otherLabel: string | null
  children: React.ReactNode
}) {
  // Docked on a phone the readout sits over a short plot, so it packs into
  // two columns and folds the month's events into one line.
  const docked = React.useContext(DockedContext)
  return (
    <div className={cn("grid", docked && "grid-cols-2 gap-x-3")}>
      <div className="col-span-full mb-1 flex items-baseline justify-between gap-2.5">
        <span className="inline-flex items-baseline gap-1.5">
          <b className="font-semibold">{monthLong(month)}</b>
          {actual ? (
            <span className="text-[10.5px] text-muted-foreground">Actual</span>
          ) : null}
        </span>
        {pinned ? (
          <span className="text-[10.5px] text-muted-foreground">
            {docked ? "Pinned" : "Pinned, Esc to clear"}
          </span>
        ) : null}
      </div>
      {docked && events.length ? (
        <div className="col-span-full mb-0.5 truncate text-[11px] text-muted-foreground">
          {events.map(eventText).join(" \u00b7 ")}
        </div>
      ) : null}
      {(docked ? [] : events).map((e) => (
        <div
          key={`${e.label}-${e.other ? "o" : "m"}`}
          className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <GlyphIcon type={e.type} hollow={e.other} />
          <span>
            {eventText(e)}
            {e.other && otherLabel ? ` (${otherLabel})` : ""}
          </span>
        </div>
      ))}
      {warnings.map((w) => (
        <div
          key={`${w.short}-${w.other ? "o" : "m"}`}
          className={cn(
            "col-span-full mb-1 text-[11px]",
            docked && "mb-0.5 line-clamp-2",
            w.tone === "rose" ? "text-runway-crit" : "text-runway-warn"
          )}
        >
          {w.text}
          {w.other && otherLabel ? ` (${otherLabel})` : ""}
        </div>
      ))}
      {children}
    </div>
  )
}

/** Value rows; two columns when the tooltip is docked on a phone. */
function TipRows({ children }: { children: React.ReactNode }) {
  const docked = React.useContext(DockedContext)
  return <div className={cn(docked ? "contents" : "grid")}>{children}</div>
}

function TipRow({
  k,
  v,
  swatch,
  total = false,
  tone,
  dash = false,
}: {
  k: string
  v: string
  swatch?: string
  total?: boolean
  tone?: "crit"
  dash?: boolean
}) {
  const docked = React.useContext(DockedContext)
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-2 leading-[1.7]",
        total && !docked && "mt-0.5 border-t pt-0.5"
      )}
    >
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5",
          total ? "text-foreground" : "text-muted-foreground",
          tone === "crit" && "text-runway-crit"
        )}
      >
        {swatch ? (
          <i
            className="inline-block h-0.5 w-2.5 shrink-0 rounded-[1px]"
            style={{ background: swatch }}
          />
        ) : null}
        {dash ? <DashIcon /> : null}
        <span className="truncate">{k}</span>
      </span>
      <span
        className={cn(
          "whitespace-pre font-medium font-mono text-foreground tabular-nums",
          tone === "crit" && "text-runway-crit"
        )}
      >
        {v}
      </span>
    </div>
  )
}

function CompareRow({
  label,
  value,
  base,
}: {
  label: string
  value: number
  base: number
}) {
  return (
    <TipRow dash k={label} v={`${money(value)}  ${signedK(value - base)}`} />
  )
}

function Notes({
  warnings,
  info,
  otherLabel,
  pinnedIndex,
  onPin,
}: {
  warnings: ChartWarning[]
  info: string | null
  otherLabel: string | null
  pinnedIndex: number | null
  onPin: (i: number) => void
}) {
  if (!warnings.length && !info) return null
  return (
    <div className="grid gap-0.5 border-t px-2 py-1.5">
      {warnings.map((w) => (
        <button
          key={`${w.i}-${w.short}-${w.other ? "o" : "m"}`}
          type="button"
          aria-current={pinnedIndex === w.i ? "true" : undefined}
          onClick={() => onPin(w.i)}
          className={cn(
            "flex w-full items-start gap-2 rounded-md p-1.5 text-left text-xs outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:bg-muted pointer-coarse:min-h-11 motion-reduce:transition-none",
            w.tone === "rose" ? "text-runway-crit" : "text-runway-warn"
          )}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="text-pretty">{w.text}</span>
          {w.other && otherLabel ? (
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-muted px-1.5 text-[10.5px] text-foreground/80">
              {otherLabel}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {monthAbbr(w.month)}
          </span>
        </button>
      ))}
      {info ? (
        <p className="p-1.5 text-muted-foreground text-xs">{info}</p>
      ) : null}
    </div>
  )
}
