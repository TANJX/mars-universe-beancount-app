"use client"

// The /runway page. Person, scenario and chart view live in the URL; the
// inputs are ephemeral page edits over the person's config (they reset when
// the person changes). The active scenario re-runs on every edit; the
// comparison of all scenarios runs on a deferred copy so typing stays quick.
//
// Same workbench as /fire: chart pinned on the left, controls pane scrolling
// on the right at xl; one column with a sticky chart below it.

import { AlertTriangle, PanelRightOpen } from "lucide-react"
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs"
import * as React from "react"

import { PANE_FILL, SectionNav, usePaneOpen } from "@/components/fire/workbench"
import { personInputs } from "@/lib/runway/config"
import { compareScenarios, simulate } from "@/lib/runway/engine"
import {
  SLEEVES,
  type SleeveId,
  sleeveUsed,
  sleeveValue,
} from "@/lib/runway/sleeves"
import type {
  RunwayData,
  RunwayInputs,
  RunwayIssue,
  RunwayPerson,
  UnavailablePerson,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { RunwayChartCard } from "./chart-card"
import { monthLabel } from "./chart-utils"
import { ScenarioCompare } from "./compare"
import {
  NotModeled,
  PersonStatusState,
  SleeveExplainer,
  sleeveInfos,
} from "./explainer"
import {
  type PersonOption,
  RunwayHeader,
  RunwayKpiStrip,
  RunwayKpis,
} from "./header"
import { RunwayInputsPanel } from "./inputs"
import { MonthlyTable } from "./monthly-table"

const SECTIONS = [
  { id: "runway-inputs", label: "Inputs" },
  { id: "runway-compare", label: "Compare" },
  { id: "runway-months", label: "Months" },
  { id: "runway-sleeves", label: "Sleeves" },
]

const VIEWS = ["sleeves", "flow", "play"] as const

export function RunwayView({
  data,
  onReload,
}: {
  data: RunwayData
  onReload: () => void
}) {
  const order = new Map(data.order.map((id, i) => [id, i]))
  const options: PersonOption[] = [
    ...data.people.map((p) => ({
      id: p.id,
      name: p.label,
      status: "ok" as const,
    })),
    ...data.unavailable.map((u) => ({
      id: u.id,
      name: u.label,
      status: u.status,
    })),
  ].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
  const [personParam, setPersonParam] = useQueryState("person", parseAsString)
  const personId =
    options.find((o) => o.id === personParam)?.id ?? options[0]?.id ?? ""
  const person = data.people.find((p) => p.id === personId)
  const unavailable = data.unavailable.find((u) => u.id === personId)

  return (
    <RunwayPersonView
      // Edits belong to one person: switching remounts with fresh inputs.
      key={personId}
      data={data}
      options={options}
      personId={personId}
      onPersonChange={(id) => void setPersonParam(id)}
      person={person ?? null}
      unavailable={unavailable ?? null}
      onReload={onReload}
    />
  )
}

function RunwayPersonView({
  data,
  options,
  personId,
  onPersonChange,
  person,
  unavailable,
  onReload,
}: {
  data: RunwayData
  options: PersonOption[]
  personId: string
  onPersonChange: (id: string) => void
  person: RunwayPerson | null
  unavailable: UnavailablePerson | null
  onReload: () => void
}) {
  const config = React.useMemo<RunwayInputs | null>(
    () => (person ? personInputs(person, data) : null),
    [person, data]
  )
  const [inputs, setInputs] = React.useState<RunwayInputs | null>(config)
  const [scenarioParam, setScenarioParam] = useQueryState(
    "scenario",
    parseAsString
  )
  const [view, setView] = useQueryState(
    "view",
    parseAsStringLiteral(VIEWS).withDefault("sleeves")
  )
  const [hidden, setHidden] = React.useState<Set<SleeveId>>(new Set())
  const [paneOpen, setPane] = usePaneOpen("runway.controlsOpen")
  const paneRef = React.useRef<HTMLElement>(null)

  const scenarios = inputs?.person.scenarios ?? []
  const scenario =
    scenarios.find((s) => s.id === scenarioParam) ?? scenarios[0] ?? null
  const scenarioId = scenario?.id ?? "stay"

  const result = React.useMemo(
    () => (inputs ? simulate(inputs, scenarioId) : null),
    [inputs, scenarioId]
  )
  const deferred = React.useDeferredValue(inputs)
  const compared = React.useMemo(
    () => (deferred ? compareScenarios(deferred) : {}),
    [deferred]
  )

  // Below xl the chart section is sticky over the pane. A sticky block taller
  // than its scroller would cover the whole page, so stay sticky only while
  // the section leaves room (120px) for the pane to scroll under it.
  const stickyRef = React.useRef<HTMLElement>(null)
  const stickyOk = useFitsSticky(stickyRef, 120)

  const rows = result?.rows ?? []
  const first = rows[0]?.month ?? data.start
  const last = rows.at(-1)?.month ?? data.start
  const periodLabel = `${monthLabel(first)} to ${monthLabel(last)}`
  const dirty = JSON.stringify(inputs) !== JSON.stringify(config)
  const used = SLEEVES.filter((s) => sleeveUsed(rows, s.id)).map((s) => s.id)
  const endRow = rows.at(-1)
  const endValues: Partial<Record<SleeveId, number>> = {}
  if (endRow) for (const id of used) endValues[id] = sleeveValue(endRow, id)

  const toggle = (id: SleeveId) =>
    setHidden((h) => {
      const next = new Set(h)
      if (next.has(id)) next.delete(id)
      else if (used.filter((u) => !next.has(u)).length > 1) next.add(id)
      return next
    })
  const solo = (id: SleeveId) =>
    setHidden((h) => {
      const others = used.filter((u) => u !== id)
      // Solo again on the only visible sleeve brings everything back.
      if (others.every((u) => h.has(u)) && !h.has(id)) return new Set()
      return new Set(others)
    })

  const issues = issuesFor(data, personId)
  const hasNotices = !data.fromConfig || issues.length > 0
  const notices = (
    <>
      {!data.fromConfig ? (
        <div className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-400">
          <AlertTriangle size={12} className="shrink-0" />
          No config/runway.yaml in the ledger: showing a demo plan. Copy
          runway.example.yaml to start.
        </div>
      ) : null}
      <IssueList issues={issues} />
    </>
  )

  return (
    <div
      className={cn(
        "flex flex-col xl:grid xl:h-full",
        paneOpen
          ? "xl:grid-cols-[minmax(0,1.45fr)_minmax(26rem,1fr)]"
          : "xl:grid-cols-[minmax(0,1fr)_auto]"
      )}
    >
      <section
        ref={stickyRef}
        className={cn(
          "z-10 flex flex-col gap-3 bg-background px-4 pt-2 pb-3 md:px-6 xl:static xl:min-h-0 xl:overflow-y-auto",
          stickyOk && "sticky top-0"
        )}
      >
        <RunwayHeader
          people={options}
          personId={personId}
          onPersonChange={onPersonChange}
          scenarios={scenarios}
          scenarioId={scenarioId}
          onScenarioChange={(id) => void setScenarioParam(id)}
          dirty={dirty}
          onReset={() => setInputs(config)}
          periodLabel={periodLabel}
        >
          {/* Headline numbers sit in the header on wide screens only; below xl
              they scroll with the pane so the sticky part stays short. */}
          {result && inputs ? (
            <div className="hidden xl:block">
              <RunwayKpis
                result={result}
                inputs={inputs}
                endLabel={monthLabel(last)}
              />
            </div>
          ) : null}
        </RunwayHeader>
        {hasNotices ? (
          <div className="hidden flex-col gap-3 xl:flex">{notices}</div>
        ) : null}

        {result && inputs ? (
          <>
            <RunwayChartCard
              result={result}
              inputs={inputs}
              view={view}
              onViewChange={(v) => void setView(v)}
              hidden={hidden}
              onToggleSleeve={toggle}
              onSoloSleeve={solo}
              playCap={inputs.person.playCap}
              periodLabel={periodLabel}
            />
            <RunwayKpiStrip
              result={result}
              inputs={inputs}
              className="hidden xl:grid"
            />
          </>
        ) : unavailable ? (
          <PersonStatusState
            name={unavailable.label}
            status={unavailable.status}
            file={unavailable.file}
            message={unavailable.message}
            onReload={onReload}
          />
        ) : (
          <PersonStatusState
            name="this person"
            status="error"
            message="No people in config/runway.yaml."
            onReload={onReload}
          />
        )}
      </section>

      {hasNotices || (result && inputs) ? (
        <div className="flex flex-col gap-3 px-4 pt-1 pb-4 md:px-6 xl:hidden">
          {notices}
          {result && inputs ? (
            <RunwayKpis
              result={result}
              inputs={inputs}
              endLabel={monthLabel(last)}
            />
          ) : null}
        </div>
      ) : null}

      {paneOpen ? null : (
        <button
          type="button"
          onClick={() => setPane(true)}
          aria-label="Show controls"
          className={cn(
            "my-3 mr-3 hidden w-10 flex-col items-center gap-3 rounded-xl pt-3 text-muted-foreground text-xs transition-colors hover:text-foreground xl:flex",
            PANE_FILL
          )}
        >
          <PanelRightOpen size={15} />
          <span className="[writing-mode:vertical-rl]">Controls</span>
        </button>
      )}

      {inputs && config && result && scenario ? (
        <section
          ref={paneRef}
          className={cn(
            "mx-4 mb-4 flex min-w-0 flex-col gap-4 rounded-xl px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] xl:mx-0 xl:my-3 xl:mr-3 xl:min-h-0 xl:overflow-x-hidden xl:overflow-y-auto",
            PANE_FILL,
            !paneOpen && "xl:hidden"
          )}
        >
          <SectionNav
            sections={SECTIONS}
            paneRef={paneRef}
            onFold={() => setPane(false)}
          />
          <div id="runway-inputs" className="flex scroll-mt-12 flex-col gap-4">
            <RunwayKpiStrip
              result={result}
              inputs={inputs}
              className="xl:hidden"
            />
            <RunwayInputsPanel
              inputs={inputs}
              config={config}
              scenario={scenario}
              onChange={setInputs}
            />
          </div>
          <div id="runway-compare" className="scroll-mt-12">
            {scenarios.length > 1 ? (
              <ScenarioCompare
                scenarios={scenarios}
                results={compared}
                activeId={scenarioId}
                onSelect={(id) => void setScenarioParam(id)}
              />
            ) : (
              <p className="px-1 text-muted-foreground text-xs">
                One job scenario in config. Add a scenario (a new job from a
                given month) to compare.
              </p>
            )}
          </div>
          <div id="runway-months" className="scroll-mt-12">
            <MonthlyTable rows={rows} showOther={used.includes("other")} />
          </div>
          <div id="runway-sleeves" className="flex scroll-mt-12 flex-col gap-4">
            <SleeveExplainer
              sleeves={sleeveInfos(inputs.person.sleeveText, used)}
              endValues={endValues}
            />
            <NotModeled items={inputs.person.notModeled} />
          </div>
        </section>
      ) : null}
    </div>
  )
}

/** True while the element plus `room` px fits inside its scrolling ancestor.
 * Re-checked when either one resizes (rotation, notes appearing, person
 * switch). Defaults to true so the first paint matches the wide layout. */
function useFitsSticky(
  ref: React.RefObject<HTMLElement | null>,
  room: number
): boolean {
  const [fits, setFits] = React.useState(true)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let scroller: HTMLElement | null = el.parentElement
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY
      if (oy === "auto" || oy === "scroll") break
      scroller = scroller.parentElement
    }
    const check = () => {
      const avail = scroller ? scroller.clientHeight : window.innerHeight
      setFits(el.offsetHeight + room <= avail)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (scroller) ro.observe(scroller)
    window.addEventListener("resize", check)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", check)
    }
  }, [ref, room])
  return fits
}

function issuesFor(data: RunwayData, personId: string): RunwayIssue[] {
  const unavailableIds = new Set(data.unavailable.map((u) => u.id))
  return [
    ...data.errors.filter(
      (e) =>
        (e.personId === personId || e.personId === null) &&
        !unavailableIds.has(e.personId ?? "") &&
        !/^people\[\d+\](\.include)?$/.test(e.path)
    ),
    ...data.warnings.filter(
      (w) => w.personId === personId || w.personId === null
    ),
  ]
}

function IssueList({ issues }: { issues: RunwayIssue[] }) {
  if (!issues.length) return null
  const shown = issues.slice(0, 3)
  return (
    <div className="flex flex-col gap-0.5 text-amber-600 text-xs dark:text-amber-400">
      {shown.map((i) => (
        <span
          key={`${i.path}-${i.message}`}
          className="flex items-start gap-1.5"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span title={i.path ?? undefined}>{i.message}</span>
        </span>
      ))}
      {issues.length > shown.length ? (
        <span className="pl-[18px] text-muted-foreground">
          and {issues.length - shown.length} more in config/runway.yaml
        </span>
      ) : null}
    </div>
  )
}
