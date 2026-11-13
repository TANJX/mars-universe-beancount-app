"use client"

// The /runway page. Person, scenario and chart view live in the URL. Edits
// are drafts per person (hooks/use-runway-drafts.ts) that survive switching
// person or scenario; Save writes them back to the YAML. The active plan
// re-runs on every edit; the comparison of all scenarios runs on a deferred
// copy so typing stays quick.
//
// Same workbench as /fire: chart pinned on the left, controls pane scrolling
// on the right at xl; one column with a sticky chart below it.

import { AlertTriangle, PanelRightOpen } from "lucide-react"
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs"
import * as React from "react"

import { usd } from "@/components/fire/controls"
import { PANE_FILL, SectionNav, usePaneOpen } from "@/components/fire/workbench"
import { type RunwaySaveError, useRunwaySave } from "@/hooks/use-runway"
import { type RunwayDrafts, useRunwayDrafts } from "@/hooks/use-runway-drafts"
import { bodyOf, personInputs, runnable } from "@/lib/runway/config"
import { ACCOUNT_LABEL } from "@/lib/runway/contributions"
import {
  addScenario,
  bodyIn,
  deleteScenario,
  draftChanges,
  isDirty,
  isSharedDirty,
  issueTarget,
  type PersonDraft,
  renameScenario,
  resetToShared,
  saveBody,
  savedBodyIn,
  scenarioNameError,
  setBody,
} from "@/lib/runway/drafts"
import { compareScenarios, simulate } from "@/lib/runway/engine"
import {
  countChanges,
  countChangesOver,
  deepEqual,
  diffPatch,
  getPath,
  setPath,
} from "@/lib/runway/patch"
import { monthSpan } from "@/lib/runway/schedule"
import {
  SLEEVES,
  type SleeveId,
  sleeveUsed,
  sleeveValue,
} from "@/lib/runway/sleeves"
import {
  CONTRIBUTION_ACCOUNTS,
  PLAN_ID,
  type PlanBody,
  type RunwayData,
  type RunwayIssue,
  type RunwayResult,
  type UnavailablePerson,
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
import { type FallbackFor, RunwayInputsPanel } from "./inputs"
import { JobsSection } from "./jobs"
import { MonthlyTable } from "./monthly-table"
import { SaveBar, type SaveState } from "./save-bar"
import { ReadOnlyBanner, ScenarioBar, ScenarioNote } from "./scenario-bar"
import { SharedSection, valueIn } from "./shared"

const SECTIONS = [
  { id: "runway-inputs", label: "Inputs" },
  { id: "runway-shared", label: "Shared" },
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
  const drafts = useRunwayDrafts(data)
  const order = new Map(data.order.map((id, i) => [id, i]))
  const options: PersonOption[] = [
    ...data.people.map((p) => ({
      id: p.id,
      name: drafts.people[p.id]?.plan.label ?? p.plan.label,
      status: "ok" as const,
      dirty: drafts.people[p.id] ? isDirty(drafts.people[p.id]) : false,
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
  const unavailable = data.unavailable.find((u) => u.id === personId)

  return (
    <RunwayPersonView
      // View state (hidden sleeves, chart) belongs to one person; edits live
      // in `drafts`, above this remount.
      key={personId}
      data={data}
      drafts={drafts}
      options={options}
      personId={personId}
      onPersonChange={(id) => void setPersonParam(id)}
      unavailable={unavailable ?? null}
      onReload={onReload}
    />
  )
}

function RunwayPersonView({
  data,
  drafts,
  options,
  personId,
  onPersonChange,
  unavailable,
  onReload,
}: {
  data: RunwayData
  drafts: RunwayDrafts
  options: PersonOption[]
  personId: string
  onPersonChange: (id: string) => void
  unavailable: UnavailablePerson | null
  onReload: () => void
}) {
  const draft: PersonDraft | null = drafts.people[personId] ?? null
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
  const [barHeight, setBarHeight] = React.useState(0)
  const months = React.useMemo(
    () => monthSpan(data.start, data.months),
    [data.start, data.months]
  )

  const scenarioId =
    draft?.scenarios.find((s) => s.id === scenarioParam)?.id ?? PLAN_ID
  const isPlan = scenarioId === PLAN_ID
  const selectScenario = (id: string) =>
    void setScenarioParam(id === PLAN_ID ? null : id)

  const body = draft ? bodyIn(draft, scenarioId) : null
  const savedBody = draft ? savedBodyIn(draft, scenarioId) : null
  const base = draft && !isPlan ? draft.plan : null
  const person = draft && body ? runnable(draft.saved, body, data.start) : null
  const inputs = person ? personInputs(person, data) : null
  const config =
    draft && person
      ? personInputs(
          runnable(draft.saved, savedBody ?? body ?? draft.plan, data.start),
          data
        )
      : null
  const readOnly = draft?.saved.readOnly ?? false

  const result = React.useMemo(
    () => (inputs ? simulate(inputs) : null),
    [inputs]
  )
  const runs = React.useMemo(
    () =>
      draft
        ? [
            { id: PLAN_ID, body: draft.plan },
            ...draft.scenarios.map((s) => ({
              id: s.id,
              body: bodyIn(draft, s.id),
            })),
          ].map((r) => ({
            id: r.id,
            inputs: personInputs(
              runnable(draft.saved, r.body, data.start),
              data
            ),
          }))
        : [],
    [draft, data]
  )
  const deferredRuns = React.useDeferredValue(runs)
  const compared = React.useMemo(
    () => compareScenarios(deferredRuns),
    [deferredRuns]
  )
  const scenarioOptions = [
    { id: PLAN_ID, label: "Plan" },
    ...(draft?.scenarios.map((s) => ({ id: s.id, label: s.label })) ?? []),
  ]

  const update = (fn: (d: PersonDraft) => PersonDraft) =>
    drafts.update(personId, fn)
  const setActiveBody = (next: PlanBody) =>
    update((d) => setBody(d, scenarioId, next))

  // ---- save
  const save = useRunwaySave()
  const [saveState, setSaveState] = React.useState<SaveState>({ kind: "idle" })
  const undoRef = React.useRef<ReturnType<RunwayDrafts["discard"]> | null>(null)
  const timer = React.useRef<number | undefined>(undefined)
  const later = (ms: number, fn: () => void) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fn, ms)
  }
  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  const changes = draft ? draftChanges(draft) : null
  const sharedDirty = isSharedDirty(drafts.shared)
  const sharedChanges = sharedDirty
    ? countChanges(diffPatch(drafts.shared.edited, drafts.shared.saved))
    : 0
  const totalChanges = (changes?.total ?? 0) + sharedChanges
  const label = draft?.plan.label ?? ""
  const targets = [
    changes?.total
      ? `${label}: ${[
          ...(changes.plan || changes.overrides ? ["Plan"] : []),
          ...changes.scenarios.map((s) => s.label),
        ].join(", ")}`
      : null,
    sharedDirty ? "Shared (changes both people)" : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const otherDirty = options.find((o) => o.id !== personId && o.dirty)

  const onSave = () => {
    const req = saveBody(data.version, draft, drafts.shared)
    if (!req.person && !req.shared) return
    const files = [
      ...(req.person && draft ? [draft.saved.file] : []),
      ...(req.shared ? ["config/runway.yaml"] : []),
    ].filter((f, i, all) => all.indexOf(f) === i)
    setSaveState({ kind: "saving", files })
    save.mutate(req, {
      onSuccess: (r) => {
        drafts.expectReset([
          ...(req.person ? [personId] : []),
          ...(req.shared ? ["shared"] : []),
        ])
        setSaveState({
          kind: "saved",
          files: r.written.length ? r.written : files,
        })
        later(2500, () => setSaveState({ kind: "idle" }))
      },
      onError: (e: RunwaySaveError) => {
        if (e.status === 0) setSaveState({ kind: "unreachable" })
        else if (e.status === 409) {
          onReload()
          setSaveState({
            kind: "conflict",
            message:
              "The YAML files changed since the page loaded. They are reloaded and your edits are kept; Save again to write them.",
          })
        } else if (e.status === 422 && e.issues.length) {
          const unmapped = e.issues.filter(
            (i) => !issueTarget(i.path, draft?.scenarios ?? [])
          )
          setSaveState({ kind: "invalid", issues: e.issues, unmapped })
        } else
          setSaveState({
            kind: "failed",
            message: `Couldn't save: ${e.message}`,
          })
      },
    })
  }
  const onDiscard = () => {
    const n = totalChanges
    undoRef.current = drafts.discard(personId)
    setSaveState({ kind: "discarded", n })
    later(6000, () => {
      undoRef.current = null
      setSaveState({ kind: "idle" })
    })
  }
  const onUndo = () => {
    if (undoRef.current) drafts.restore(undoRef.current)
    undoRef.current = null
    setSaveState({ kind: "idle" })
  }

  // Server errors for the active target, by body-relative path.
  const errors: Record<string, string> = {}
  if (saveState.kind === "invalid" && draft)
    for (const i of saveState.issues) {
      const t = issueTarget(i.path, draft.scenarios)
      if (t && t.scenarioId === scenarioId && i.personId === personId)
        errors[t.path] = i.message
    }
  const showFirstError = () => {
    const el = paneRef.current?.querySelector("[data-field-error]")
    el?.scrollIntoView({ block: "center", behavior: "smooth" })
    const input = el?.parentElement?.querySelector<HTMLElement>(
      "input, select, button"
    )
    input?.focus({ preventScroll: true })
  }

  // ---- override markers
  const fallbackFor: FallbackFor = (path, format) => {
    if (!draft || !body || readOnly) return null
    if (base) {
      const mine = getPath(body, path)
      const theirs = getPath(base, path)
      if (deepEqual(mine, theirs)) return null
      const shared = draft.overrides.includes(path)
        ? ""
        : getPath(drafts.shared.edited, path) !== undefined
          ? " (shared)"
          : ""
      return {
        source: "Plan",
        text: `${format(theirs)}${shared}`,
        onReset: () => setActiveBody(setPath(body, path, theirs)),
      }
    }
    if (!draft.overrides.includes(path)) return null
    const v = getPath(drafts.shared.edited, path)
    if (v === undefined) return null
    return {
      source: "Shared",
      text: format(v),
      onReset: () =>
        update((d) => resetToShared(d, path, drafts.shared.edited)),
    }
  }

  // Below xl the chart section is sticky over the pane. A sticky block taller
  // than its scroller would cover the whole page, so stay sticky only while
  // the section leaves room (120px plus the save bar) for the pane to scroll.
  const stickyRef = React.useRef<HTMLElement>(null)
  const stickyOk = useFitsSticky(stickyRef, 120 + barHeight)

  const rows = result?.rows ?? []
  const first = rows[0]?.month ?? data.start
  const last = rows.at(-1)?.month ?? data.start
  const periodLabel = `${monthLabel(first)} to ${monthLabel(last)}`
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

  const issues = [
    ...(result ? limitIssues(result, personId) : []),
    ...issuesFor(data, personId),
  ]
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

  const scenarioChanges = (id: string) => {
    const s = draft?.scenarios.find((x) => x.id === id)
    return s && draft && Object.keys(s.patch).length
      ? countChangesOver(draft.plan, s.patch)
      : 0
  }

  const scenarioBar = draft ? (
    <ScenarioBar
      scenarios={scenarioOptions}
      activeId={scenarioId}
      onSelect={selectScenario}
      readOnly={readOnly || !data.fromConfig}
      nameError={(v, selfId) => scenarioNameError(draft, v, label, selfId)}
      changesIn={scenarioChanges}
      onCreate={(name, from) => {
        const made = addScenario(draft, name, from)
        update(() => made.draft)
        selectScenario(made.id)
      }}
      onRename={(id, name) => update((d) => renameScenario(d, id, name))}
      onDelete={(id) => {
        update((d) => deleteScenario(d, id))
        selectScenario(PLAN_ID)
      }}
    />
  ) : null

  const canSave = data.fromConfig
  return (
    <div
      className={cn(
        "flex flex-col xl:grid xl:h-full",
        paneOpen
          ? "xl:grid-cols-[minmax(0,1.45fr)_minmax(26rem,1fr)]"
          : "xl:grid-cols-[minmax(0,1fr)_auto]"
      )}
      style={{ "--savebar-h": `${barHeight}px` } as React.CSSProperties}
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
          scenarioBar={scenarioBar}
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

      {inputs && config && result && draft && body ? (
        <section
          ref={paneRef}
          inert={saveState.kind === "saving" || undefined}
          aria-busy={saveState.kind === "saving" || undefined}
          className={cn(
            "mx-4 mb-4 flex min-w-0 flex-col gap-4 rounded-xl px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] max-xl:mb-[calc(1rem+var(--savebar-h))] xl:mx-0 xl:my-3 xl:mr-3 xl:min-h-0 xl:overflow-x-hidden xl:overflow-y-auto xl:pb-0",
            PANE_FILL,
            !paneOpen && "xl:hidden"
          )}
        >
          <SectionNav
            sections={SECTIONS}
            paneRef={paneRef}
            onFold={() => setPane(false)}
          />
          {readOnly ? <ReadOnlyBanner file={draft.saved.file} /> : null}
          <ScenarioNote
            label={
              scenarioOptions.find((s) => s.id === scenarioId)?.label ?? ""
            }
            isPlan={isPlan}
            changes={scenarioChanges(scenarioId)}
            hasScenarios={draft.scenarios.length > 0}
            onEditPlan={() => selectScenario(PLAN_ID)}
          />
          <fieldset
            id="runway-inputs"
            disabled={readOnly}
            className="m-0 flex min-w-0 scroll-mt-12 flex-col gap-4 border-0 p-0"
          >
            <RunwayKpiStrip
              result={result}
              inputs={inputs}
              className="xl:hidden"
            />
            <RunwayInputsPanel
              inputs={inputs}
              config={config}
              result={result}
              fallbackFor={fallbackFor}
              onChange={(next) => setActiveBody(bodyOf(next.person))}
              jobs={
                <JobsSection
                  key={scenarioId}
                  body={body}
                  saved={savedBody}
                  base={base}
                  months={months}
                  readOnly={readOnly}
                  errors={errors}
                  onChange={setActiveBody}
                />
              }
            />
          </fieldset>
          <div id="runway-shared" className="scroll-mt-12">
            <SharedSection
              shared={drafts.shared.edited}
              saved={drafts.shared.saved}
              inScenario={!isPlan}
              onChange={drafts.setShared}
              people={data.people.map((p) => {
                const d = drafts.people[p.id]
                return {
                  label: d?.plan.label ?? p.plan.label,
                  overrides: d?.overrides ?? p.overrides,
                  value: valueIn(d?.plan ?? p.plan),
                }
              })}
            />
          </div>
          <div id="runway-compare" className="scroll-mt-12">
            {scenarioOptions.length > 1 ? (
              <ScenarioCompare
                scenarios={scenarioOptions}
                results={compared}
                activeId={scenarioId}
                onSelect={selectScenario}
              />
            ) : (
              <p className="px-1 text-muted-foreground text-xs">
                Only Plan so far. Create a scenario from the ⋯ menu beside the
                scenario switch to compare what changes.
              </p>
            )}
          </div>
          <div id="runway-months" className="scroll-mt-12">
            <MonthlyTable rows={rows} showOther={used.includes("other")} />
          </div>
          <div
            id="runway-sleeves"
            className="flex scroll-mt-12 flex-col gap-4 pb-4"
          >
            <SleeveExplainer
              sleeves={sleeveInfos(inputs.person.sleeveText, used)}
              endValues={endValues}
            />
            <NotModeled items={inputs.person.notModeled} />
          </div>
          {canSave ? (
            <SaveBar
              state={saveState}
              changes={totalChanges}
              targets={targets}
              restored={drafts.restored.includes(personId)}
              stale={drafts.stale.includes(personId) ? draft.saved.file : null}
              others={
                otherDirty
                  ? { id: otherDirty.id, label: otherDirty.name }
                  : null
              }
              onSave={onSave}
              onDiscard={onDiscard}
              onUndo={onUndo}
              onShow={showFirstError}
              onSwitch={onPersonChange}
              onHeight={setBarHeight}
            />
          ) : null}
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

/** Contribution limits the current inputs run into, from the live run so
 * they follow page edits. An excess gets a line per year. A fixed or percent
 * stream that asks for more than its limit gets one line per account (the
 * engine stops it there; payroll may not), and only when the overshoot is
 * more than 1% of the limit: a few dollars shows on the card, not up here. */
function limitIssues(result: RunwayResult, personId: string): RunwayIssue[] {
  const out: RunwayIssue[] = []
  const years = Object.keys(result.pools).sort()
  for (const a of CONTRIBUTION_ACCOUNTS) {
    const name = ACCOUNT_LABEL[a]
    const clipped: string[] = []
    let firstDate: string | null = null
    for (const year of years) {
      const pool = result.pools[year][a]
      if (pool.excess > 0)
        out.push({
          personId,
          path: "contributions",
          message: `${name} is ${usd(pool.excess)} over its ${year} limit of ${usd(pool.limit)}`,
        })
      else if (pool.clippedDate && pool.cut > pool.limit * 0.01) {
        clipped.push(year)
        firstDate ??= pool.clippedDate
      }
    }
    if (firstDate)
      out.push({
        personId,
        path: "contributions",
        message: `${name} asks for more than its limit allows from ${firstDate}${
          clipped.length > 1
            ? ` (and again in ${clipped.slice(1).join(", ")})`
            : ""
        }. This plan stops at the limit; payroll may not`,
      })
  }
  return out
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
          and {issues.length - shown.length} more
        </span>
      ) : null}
    </div>
  )
}
