"use client"

// The /fire page. Holds one `Inputs` state seeded from `config/fire.yaml`,
// re-runs the deterministic projection on every edit and the Monte Carlo on a
// deferred copy (so sliders stay responsive), and lays out:
// header stats → chart → ground truth + levers → people → events →
// what moves the date → concepts → scenarios → year table.

import {
  AlertTriangle,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useDeleteScenario, useSaveScenario } from "@/hooks/use-fire"
import { applyScenario, type FireData } from "@/lib/fire/config"
import {
  leverImpacts,
  monteCarlo,
  simulate,
  timelineMarks,
} from "@/lib/fire/engine"
import { monthIndex } from "@/lib/fire/equity"
import type { Inputs, Mode, Path, Scenario, Tier } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { type ConceptExtras, ConceptsPanel } from "./concepts"
import {
  InfoTip,
  NumberField,
  pct,
  SectionCard,
  Segmented,
  Stat,
  Toggle,
  usd,
  YearStepper,
} from "./controls"
import { EventsPanel } from "./events"
import { GroundTruth } from "./ground-truth"
import { AssumptionsPanel, ImpactPanel } from "./levers"
import { PeoplePanel } from "./people"
import { ProjectionChart, ProjectionLegend } from "./projection-chart"
import { type ComparedRow, ScenariosPanel } from "./scenarios"
import { YearTable } from "./year-table"

const FREE_LABEL: Record<Path, string> = {
  normal: "FI year",
  coast: "Coast from",
  barista: "Barista from",
}

const MEDIAN_LABEL: Record<Path, string> = {
  normal: "FI",
  coast: "coast from",
  barista: "barista from",
}

const CHART_TITLE: Record<Path, string> = {
  normal: "Portfolio vs FI target (real dollars; save until FI, then withdraw)",
  coast:
    "Portfolio vs FI target (real dollars; save until the coast line, coast until full retirement age, then withdraw)",
  barista:
    "Portfolio vs FI target (real dollars; save until portfolio + side income covers spend, then top up)",
}

const PATH_HELP: Record<Path, string> = {
  normal:
    "Save until the portfolio reaches the FI target, then stop work and withdraw the retirement spend.",
  coast:
    "Save until the portfolio crosses the coast line. From then on work only covers living costs (no saving, no withdrawals) and growth carries the portfolio to the FI target by the full retirement age, when withdrawals start. If it gets there sooner (an ISO payout, say), withdrawals start then.",
  barista:
    "Save until the portfolio plus side income covers retirement spend. Then leave full-time work: side income pays part and the portfolio tops up the rest until the full retirement age, after which it funds everything.",
}

export function FireView({ data }: { data: FireData }) {
  const { snapshot } = data
  const [inputs, setInputs] = React.useState<Inputs>(data.inputs)
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [compareIds, setCompareIds] = React.useState<string[]>([])
  const [showBand, setShowBand] = React.useState(true)
  const [showEvents, setShowEvents] = React.useState(true)
  const [horizonAge, setHorizonAge] = React.useState(75)
  const paneRef = React.useRef<HTMLElement>(null)
  // Folding gives the chart the full width; remembered per browser.
  const [paneOpen, setPaneOpen] = React.useState(true)
  React.useEffect(() => {
    try {
      if (localStorage.getItem(PANE_KEY) === "0") setPaneOpen(false)
    } catch {}
  }, [])
  const setPane = (open: boolean) => {
    setPaneOpen(open)
    try {
      localStorage.setItem(PANE_KEY, open ? "1" : "0")
    } catch {}
  }
  const save = useSaveScenario()
  const del = useDeleteScenario()

  const result = React.useMemo(
    () => simulate(inputs, snapshot),
    [inputs, snapshot]
  )

  // Monte Carlo and the lever re-runs are the heavy part; let React finish the
  // slider frame first and catch up on the deferred value.
  const deferred = React.useDeferredValue(inputs)
  const mc = React.useMemo(
    () => monteCarlo(deferred, snapshot),
    [deferred, snapshot]
  )
  const deferredResult = React.useMemo(
    () => simulate(deferred, snapshot),
    [deferred, snapshot]
  )
  const impacts = React.useMemo(
    () => leverImpacts(deferred, snapshot, deferredResult.freeYear),
    [deferred, snapshot, deferredResult.freeYear]
  )
  const extras = React.useMemo<ConceptExtras>(() => {
    // Tiers are compared on the normal path so the years mean "full FI".
    const tierRun = (tier: Tier) =>
      simulate({ ...deferred, tier, path: "normal" }, snapshot)
    const lean = tierRun("lean")
    const base = tierRun("base")
    const fat = tierRun("fat")
    const barista = simulate({ ...deferred, path: "barista" }, snapshot)
    const saferSwr = Math.max(0.02, deferred.assumptions.swr - 0.005)
    const safer = monteCarlo(
      { ...deferred, assumptions: { ...deferred.assumptions, swr: saferSwr } },
      snapshot,
      300
    )
    return {
      tierYears: { lean: lean.fiYear, base: base.fiYear, fat: fat.fiYear },
      tierSpend: {
        lean: lean.retirementSpend,
        base: base.retirementSpend,
        fat: fat.retirementSpend,
      },
      baristaYear: barista.freeYear,
      baristaIncome: deferred.baristaIncome,
      saferSuccess: safer.successRate,
      saferSwr,
    }
  }, [deferred, snapshot])

  const compared = React.useMemo<ComparedRow[]>(
    () =>
      compareIds
        .map((id) => data.scenarios.find((s) => s.id === id))
        .filter((s): s is Scenario => Boolean(s))
        .map((s) => {
          const inp = applyScenario(data.inputs, s)
          return {
            id: s.id,
            name: s.name,
            mode: inp.mode,
            tier: inp.tier,
            path: inp.path,
            result: simulate(inp, snapshot),
            mc: monteCarlo(inp, snapshot),
          }
        }),
    [compareIds, data.scenarios, data.inputs, snapshot]
  )

  const primary = inputs.people[0]
  const age = (y: number | null) =>
    y && primary ? y - primary.birthYear : null
  const set = (patch: Partial<Inputs>) => setInputs((x) => ({ ...x, ...patch }))
  const tierSpend =
    inputs.mode === "household"
      ? inputs.retirementSpend.household
      : inputs.retirementSpend.individual

  const loadScenario = (s: Scenario) => {
    setInputs(applyScenario(data.inputs, s))
    setActiveId(s.id)
  }

  const freeSub = result.freeYear
    ? inputs.path === "normal"
      ? `age ${age(result.freeYear)}`
      : `age ${age(result.freeYear)} · withdrawals from ${result.drawYear ?? "–"}${
          result.drawYear &&
          primary &&
          result.drawYear < primary.birthYear + inputs.assumptions.coastAge
            ? " (full FI early)"
            : ""
        }`
    : `by age ${inputs.endAge}`

  return (
    // Workbench: the left pane (stats, chart, what moves the date) is pinned
    // to the viewport and the right pane scrolls on its own, so every edit
    // lands next to the chart it changes. Below xl the pane stacks and the
    // chart sticks to the top of the page scroll instead.
    <div
      className={cn(
        "flex flex-col xl:grid xl:h-full",
        paneOpen
          ? "xl:grid-cols-[minmax(0,1.45fr)_minmax(26rem,1fr)]"
          : "xl:grid-cols-[minmax(0,1fr)_auto]"
      )}
    >
      <section className="sticky top-0 z-10 flex flex-col gap-3 bg-background px-6 pt-2 pb-3 xl:static xl:min-h-0 xl:overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex items-center gap-2.5">
            <h1 className="font-medium text-xl tracking-tight">FIRE</h1>
            {activeId ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                {data.scenarios.find((s) => s.id === activeId)?.name}
              </span>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setInputs(data.inputs)
                setActiveId(null)
              }}
            >
              <RotateCcw /> Reset to config
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-6">
            <Stat
              label="FI target"
              value={usd(result.targetToday)}
              sub={`${usd(result.retirementSpend)}/yr at ${pct(inputs.assumptions.swr, 1)}`}
            />
            <Stat
              label="Coast FIRE"
              value={result.coastYear ?? "–"}
              sub={
                result.coastYear
                  ? `age ${age(result.coastYear)}`
                  : "not reached"
              }
            />
            <Stat
              label="Monte Carlo"
              value={pct(mc.successRate, 0)}
              sub={`median ${MEDIAN_LABEL[inputs.path]} ${mc.fiYear.p50 ?? "never"}`}
            />
            <Stat
              label={FREE_LABEL[inputs.path]}
              className="text-right"
              value={
                <span className="text-2xl">
                  {result.freeYear ?? "Not reached"}
                </span>
              }
              sub={freeSub}
            />
          </div>
        </header>
        {!data.fromConfig ? (
          <div className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-400">
            <AlertTriangle size={12} />
            No config/fire.yaml in the ledger: showing demo assumptions on your
            live net worth.
          </div>
        ) : null}

        <Card className="gap-0 overflow-hidden p-0 xl:min-h-0 xl:flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 pt-3 pb-2">
            <span className="inline-flex items-center gap-1 font-medium text-muted-foreground text-xs tracking-wide">
              Portfolio vs FI target
              <InfoTip label="Chart">{CHART_TITLE[inputs.path]}</InfoTip>
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented<string>
                value={String(horizonAge)}
                onChange={(v) => setHorizonAge(Number(v))}
                options={[65, 75, 95].map((a) => ({
                  value: String(a),
                  label: `to ${a}`,
                }))}
              />
              <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <Toggle
                  checked={showBand}
                  onChange={setShowBand}
                  label="Show Monte Carlo band"
                />
                Band
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <Toggle
                  checked={showEvents}
                  onChange={setShowEvents}
                  label="Show life events on the chart"
                />
                Events
              </span>
            </div>
          </div>
          <div className="px-4 pb-1">
            <ProjectionLegend showBand={showBand} />
          </div>
          <div className="h-[34dvh] px-2 pb-3 xl:h-auto xl:min-h-0 xl:flex-1">
            <ProjectionChart
              result={result}
              mc={showBand ? mc : null}
              marks={timelineMarks(inputs)}
              path={inputs.path}
              overlays={compared.map((c) => ({
                name: c.name,
                result: c.result,
              }))}
              showBand={showBand}
              showEvents={showEvents}
              horizonAge={horizonAge}
              primaryBirthYear={primary?.birthYear ?? 0}
            />
          </div>
          {result.depletedYear ? (
            <div className="border-t px-4 py-2 text-rose-600 text-xs dark:text-rose-400">
              At the mean return the money runs out in {result.depletedYear}.
              Lower the spend or the withdrawal rate.
            </div>
          ) : null}
        </Card>

        <div className="hidden xl:block">
          <ImpactPanel
            impacts={impacts}
            fiYear={deferredResult.freeYear}
            label={FREE_LABEL[inputs.path]}
            compact
          />
        </div>
      </section>

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

      <section
        ref={paneRef}
        className={cn(
          "mx-4 mb-4 flex min-w-0 flex-col gap-4 rounded-xl px-4 pb-6 xl:mx-0 xl:my-3 xl:mr-3 xl:min-h-0 xl:overflow-x-hidden xl:overflow-y-auto",
          PANE_FILL,
          !paneOpen && "xl:hidden"
        )}
      >
        <SectionNav paneRef={paneRef} onFold={() => setPane(false)} />

        <div id="fire-plan" className="flex scroll-mt-12 flex-col gap-4">
          <SectionCard
            title="Plan"
            hint="Who the plan covers, how they live in retirement, and how they leave full-time work."
          >
            <div className="flex flex-col gap-3 text-xs">
              <Row label="Covers">
                <Segmented<Mode>
                  value={inputs.mode}
                  onChange={(mode) => set({ mode })}
                  options={[
                    {
                      value: "individual",
                      label: primary?.name ?? "Individual",
                    },
                    { value: "household", label: "Household" },
                  ]}
                />
              </Row>
              {inputs.people.length > 1 ? (
                <Row label="Taxes">
                  <span className="inline-flex items-center gap-1.5">
                    <Toggle
                      checked={inputs.marriageYear !== null}
                      onChange={(v) =>
                        set({ marriageYear: v ? inputs.startYear + 1 : null })
                      }
                      label="File jointly after marriage"
                    />
                    {inputs.marriageYear !== null ? (
                      <>
                        file jointly from
                        <YearStepper
                          value={inputs.marriageYear}
                          onChange={(y) => set({ marriageYear: y })}
                        />
                      </>
                    ) : (
                      "file single"
                    )}
                  </span>
                  <InfoTip label="Taxes">
                    Federal tax uses joint brackets from the marriage year,
                    with both incomes combined, even when the plan covers only
                    one person. State tax stays per person.
                  </InfoTip>
                </Row>
              ) : null}
              <Row label="Retirement spend">
                <Segmented<Tier>
                  value={inputs.tier}
                  onChange={(tier) => set({ tier })}
                  options={[
                    {
                      value: "lean",
                      label: `Lean ${Math.round(tierSpend.lean / 1000)}k`,
                    },
                    {
                      value: "base",
                      label: `Base ${Math.round(tierSpend.base / 1000)}k`,
                    },
                    {
                      value: "fat",
                      label: `Fat ${Math.round(tierSpend.fat / 1000)}k`,
                    },
                    { value: "custom", label: "Custom" },
                  ]}
                />
                {inputs.tier === "custom" ? (
                  <NumberField
                    ariaLabel="Custom retirement spend"
                    prefix="$"
                    className="w-24"
                    value={inputs.customSpend}
                    onChange={(v) => set({ customSpend: Math.max(0, v) })}
                  />
                ) : null}
              </Row>
              <Row label="Path">
                <Segmented<Path>
                  value={inputs.path}
                  onChange={(path) => set({ path })}
                  options={[
                    { value: "normal", label: "Normal" },
                    { value: "coast", label: "Coast" },
                    { value: "barista", label: "Barista" },
                  ]}
                />
                <InfoTip label="Path">{PATH_HELP[inputs.path]}</InfoTip>
                {inputs.path === "barista" ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    side income
                    <NumberField
                      ariaLabel="Barista side income"
                      prefix="$"
                      className="w-24"
                      value={inputs.baristaIncome}
                      onChange={(v) => set({ baristaIncome: Math.max(0, v) })}
                    />
                    / yr
                  </span>
                ) : null}
              </Row>
            </div>
          </SectionCard>
          <AssumptionsPanel inputs={inputs} onChange={setInputs} />
          <div className="xl:hidden">
            <ImpactPanel
              impacts={impacts}
              fiYear={deferredResult.freeYear}
              label={FREE_LABEL[inputs.path]}
            />
          </div>
        </div>

        <div id="fire-people" className="scroll-mt-12">
          <PeoplePanel
            inputs={inputs}
            nowMonth={monthIndex(snapshot.asof.slice(0, 7))}
            onChange={(people) => set({ people })}
          />
        </div>

        <div id="fire-events" className="scroll-mt-12">
          <EventsPanel inputs={inputs} onChange={(events) => set({ events })} />
        </div>

        <div id="fire-scenarios" className="scroll-mt-12">
          <ScenariosPanel
            scenarios={data.scenarios}
            activeId={activeId}
            compareIds={compareIds}
            compared={compared}
            current={{
              id: "current",
              name: "Current (unsaved edits)",
              mode: inputs.mode,
              tier: inputs.tier,
              path: inputs.path,
              result,
              mc,
            }}
            saving={save.isPending}
            onSave={(name, id) =>
              save.mutate(
                { id, name, inputs },
                { onSuccess: (s) => setActiveId(s.id) }
              )
            }
            onLoad={loadScenario}
            onDelete={(id) => {
              del.mutate(id)
              setCompareIds((c) => c.filter((x) => x !== id))
              if (activeId === id) setActiveId(null)
            }}
            onToggleCompare={(id) =>
              setCompareIds((c) =>
                c.includes(id) ? c.filter((x) => x !== id) : [...c, id]
              )
            }
          />
        </div>

        <div id="fire-ledger" className="flex scroll-mt-12 flex-col gap-4">
          <GroundTruth snapshot={snapshot} inputs={inputs} />
          <YearTable result={result} inputs={inputs} />
        </div>

        <div id="fire-learn" className="scroll-mt-12">
          <ConceptsPanel
            inputs={inputs}
            result={result}
            mc={mc}
            extras={extras}
          />
        </div>
      </section>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

const PANE_KEY = "fire.controlsOpen"

/** Opaque fill for the controls pane and its sticky nav (the nav must hide
 * what scrolls under it, so no alpha). */
const PANE_FILL = "bg-[color-mix(in_oklch,var(--muted)_60%,var(--background))]"

const SECTIONS = [
  { id: "fire-plan", label: "Plan" },
  { id: "fire-people", label: "People" },
  { id: "fire-events", label: "Events" },
  { id: "fire-scenarios", label: "Scenarios" },
  { id: "fire-ledger", label: "Ledger" },
  { id: "fire-learn", label: "Learn" },
]

/** Chips that jump within the controls pane, highlighting the section in
 * view. Sticky at the top of whichever element scrolls (the pane at xl, the
 * page below it). */
function SectionNav({
  paneRef,
  onFold,
}: {
  paneRef: React.RefObject<HTMLElement | null>
  onFold: () => void
}) {
  const [active, setActive] = React.useState(SECTIONS[0].id)
  React.useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const isPane = getComputedStyle(pane).overflowY === "auto"
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (top[0]) setActive(top[0].target.id)
      },
      { root: isPane ? pane : null, rootMargin: "0px 0px -70% 0px" }
    )
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) obs.observe(el)
    }
    return () => obs.disconnect()
  }, [paneRef])

  return (
    <nav
      className={cn(
        "-mx-4 flex flex-wrap items-center gap-1 rounded-t-xl px-4 pt-3 pb-2 xl:sticky xl:top-0 xl:z-[5]",
        PANE_FILL
      )}
    >
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() =>
            document
              .getElementById(s.id)
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className={cn(
            "h-6 rounded-md px-2 text-xs transition-colors",
            active === s.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onFold}
        aria-label="Hide controls"
        title="Hide controls"
        className="ml-auto hidden size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground xl:inline-flex"
      >
        <PanelRightClose size={15} />
      </button>
    </nav>
  )
}
