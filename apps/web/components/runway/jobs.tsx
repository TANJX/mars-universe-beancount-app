"use client"

// "Jobs and pay": who pays the person and when. One lane per job over the
// horizon (salary steps as shade steps, gaps as stripes), one card per job
// (dates, salary steps, 401k match, pay overrides) and the pay defaults at
// the bottom.
//
// Windows and hints come from lib/runway/jobs.ts, the same resolver the
// engine uses, so the lanes always match the paychecks.
//
// Every edit goes through `update`, which applies a function to the latest
// body (not the one this render closed over). A blur can commit a number
// and re-sort salary steps in the same event; both edits must compose.

import { AlertTriangle, ChevronRight, X } from "lucide-react"
import * as React from "react"

import {
  NumberField,
  Segmented,
  usd,
  usdShort,
} from "@/components/fire/controls"
import { Button } from "@/components/ui/button"
import {
  activeJobAt,
  grossAt,
  type JobWindow,
  jobEnd,
  jobWindows,
} from "@/lib/runway/jobs"
import { deepEqual } from "@/lib/runway/patch"
import { addMonths } from "@/lib/runway/schedule"
import type {
  Deduction,
  Job,
  Match,
  Pay,
  PaySchedule,
  PlanBody,
  SalaryStep,
  Withholding,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { matchText } from "./contributions"
import {
  EditedDot,
  FallbackReset,
  FIELD,
  Field,
  InputsSection,
  Markers,
  MonthField,
  RowTag,
} from "./fields"
import {
  AddButton,
  box,
  CheckRow,
  DEFAULT_SCHEDULE,
  DeductionsEditor,
  deductionsText,
  errUnder,
  finePointer,
  HitToggle,
  HsaEmployerEditor,
  IconButton,
  Lock,
  marks,
  monLong,
  monName,
  pctIn,
  ScheduleEditor,
  scheduleText,
  TEXT_INPUT,
  useLocalKeys,
  WithholdingEditor,
  withholdingText,
} from "./pay-editors"

type Updater<T> = (fn: (prev: T) => T) => void

const JOB_FIELDS = [
  "employer",
  "start",
  "leave",
  "salary",
  "match",
  "schedule",
  "deductions",
  "withholding",
  "hsaEmployer",
]

/** Job colors and the gap stripe. Job 1 is the primary; dark mode lifts it,
 * because the dark primary is too dim for marks. Job 2 is a neutral slate. */
const LANE_TOKENS =
  "[--job1:var(--primary)] [--job2:oklch(0.46_0.03_255)] [--stripe:oklch(0.147_0.004_49.3/0.09)] dark:[--job1:oklch(0.66_0.17_14)] dark:[--job2:oklch(0.78_0.02_255)] dark:[--stripe:oklch(1_0_0/0.07)]"

const STRIPES =
  "repeating-linear-gradient(135deg, transparent 0 4px, var(--stripe) 4px 7px)"

const WARN = "text-amber-700 dark:text-amber-400"
const ERROR = "text-rose-600 dark:text-rose-400"

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** "Jan ’28". */
function monApos(m: string): string {
  return `${monName(m)} ’${m.slice(2, 4)}`
}

/** "+10%", "−4.5%". */
function pctDelta(x: number): string {
  const v = Math.abs(x).toFixed(1).replace(/\.0$/, "")
  return `${x >= 0 ? "+" : "−"}${v}%`
}

/** 0.04 -> "4%", 0.035 -> "3.5%". */
function pctPlain(v: number): string {
  return `${Number((v * 100).toFixed(2))}%`
}

function capitalize(s: string): string {
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : s
}

function cmpStart(a: Job, b: Job): number {
  const x = a.start ?? ""
  const y = b.start ?? ""
  return x < y ? -1 : x > y ? 1 : 0
}

/** Enabled steps in month order. */
function enabledSteps(job: Job): SalaryStep[] {
  return job.salary
    .filter((s) => s.enabled)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/** Index into `job.salary` of the step paying in `m`: the same pick as
 * grossAt (the last enabled step on or before `m`, in list order). */
function stepIndexAt(job: Job, m: string): number {
  let at = -1
  job.salary.forEach((s, i) => {
    if (s.enabled && s.from <= m) at = i
  })
  return at
}

/** "$165k → $180k +1": a job's salary list in a few characters. */
function salaryText(steps: SalaryStep[]): string {
  const on = steps
    .filter((s) => s.enabled)
    .sort((a, b) => (a.from < b.from ? -1 : 1))
  if (!on.length) return "no salary"
  let t = usdShort(on[0].gross)
  if (on[1]) t += ` → ${usdShort(on[1].gross)}`
  if (on.length > 2) t += ` +${on.length - 2}`
  return t
}

/** First and last month the job pays inside the horizon. */
function paidRange(
  job: Job,
  windows: JobWindow[]
): { from: string; to: string } | null {
  const mine = windows.filter((w) => w.jobId === job.id)
  if (!mine.length) return null
  return { from: mine[0].from, to: mine[mine.length - 1].to }
}

/** "$150k → $175k": gross in the first and last paid month. */
function payText(job: Job, windows: JobWindow[], months: string[]): string {
  const r = paidRange(job, windows)
  const first = months[0] ?? thisMonth()
  const m0 = r ? r.from : job.start && job.start > first ? job.start : first
  const a = grossAt(job, m0)
  const b = r ? grossAt(job, r.to) : a
  return a === b ? usdShort(a) : `${usdShort(a)} → ${usdShort(b)}`
}

/** The gap window right after the job's last paid window, if any. */
function gapAfter(job: Job, windows: JobWindow[]): JobWindow | null {
  let i = -1
  windows.forEach((w, k) => {
    if (w.jobId === job.id) i = k
  })
  const next = i >= 0 ? windows[i + 1] : undefined
  return next && next.jobId == null ? next : null
}

/** Collapsed summary: "Northwind $150k → $175k by Jan ’28 · Contoso $180k
 * from Jul 2028 · no pay Apr ’28 to Jun ’28". */
function sectionSummary(
  jobs: Job[],
  windows: JobWindow[],
  months: string[]
): string {
  const first = months[0] ?? thisMonth()
  const parts: string[] = []
  for (const j of jobs.filter((x) => x.enabled).sort(cmpStart)) {
    const r = paidRange(j, windows)
    if (!r) continue
    const a = grossAt(j, r.from)
    const b = grossAt(j, r.to)
    const raises = enabledSteps(j).filter(
      (s) => s.from > r.from && s.from <= r.to
    )
    let t = `${j.employer || "Unnamed job"} ${usdShort(a)}`
    const lastRaise = raises.at(-1)
    if (b !== a && lastRaise)
      t += ` → ${usdShort(b)} by ${monApos(lastRaise.from)}`
    if (parts.length > 0 || (j.start != null && j.start > first))
      t += ` from ${monLong(r.from)}`
    parts.push(t)
  }
  if (!parts.length) return "No pay"
  for (const w of windows) {
    if (w.jobId != null || w.from === first) continue
    parts.push(
      w.from === w.to
        ? `no pay ${monApos(w.from)}`
        : `no pay ${monApos(w.from)} to ${monApos(w.to)}`
    )
  }
  return parts.join(" · ")
}

function newJobId(taken: Set<string>): string {
  for (;;) {
    const id = `job-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
}

/** A step that the scenario changed: the plan's job has no enabled step in
 * the same month with the same gross. */
function stepChanged(step: SalaryStep, baseJob: Job | null): boolean {
  if (!baseJob) return false
  return !baseJob.salary.some(
    (b) => b.enabled && b.from === step.from && b.gross === step.gross
  )
}

/** "Added in scenario" is tinted; the other tags are plain. */
function ScenarioTag({ children }: { children: string }) {
  if (!children.startsWith("Added")) return <RowTag>{children}</RowTag>
  return (
    <span className="inline-flex h-4 shrink-0 items-center whitespace-nowrap rounded-full border border-primary/20 bg-primary/5 px-1.5 text-[11px] text-foreground dark:border-primary/40 dark:bg-primary/15">
      {children}
    </span>
  )
}

// ------------------------------------------------------------------ section

type Row =
  | { kind: "job"; job: Job; index: number }
  | { kind: "removed"; job: Job }

type Focus =
  | { kind: "employer" | "header" | "restore"; id: string }
  | { kind: "add" }

export function JobsSection({
  body,
  saved,
  base,
  months,
  readOnly,
  errors,
  onChange,
}: {
  body: PlanBody
  saved: PlanBody | null
  base: PlanBody | null
  months: string[]
  readOnly: boolean
  errors: Record<string, string>
  onChange: (next: PlanBody) => void
}) {
  const bodyRef = React.useRef(body)
  bodyRef.current = body
  const update = (fn: (b: PlanBody) => PlanBody) => {
    if (readOnly) return
    const next = fn(bodyRef.current)
    bodyRef.current = next
    onChange(next)
  }
  const setJob = (id: string, fn: (j: Job) => Job) =>
    update((b) => ({
      ...b,
      jobs: b.jobs.map((j) => (j.id === id ? fn(j) : j)),
    }))
  const setPay: Updater<Pay> = (fn) => update((b) => ({ ...b, pay: fn(b.pay) }))

  const rootRef = React.useRef<HTMLDivElement>(null)
  const focusRef = React.useRef<Focus | null>(null)
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(body.jobs.length === 1 ? [body.jobs[0].id] : [])
  )
  const setCardOpen = (id: string, v: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })

  // Pending focus after add/remove/restore, once the DOM has caught up.
  React.useEffect(() => {
    const f = focusRef.current
    const root = rootRef.current
    if (!f || !root) return
    focusRef.current = null
    let el: HTMLElement | null = null
    if (f.kind === "add") el = root.querySelector("[data-add-job]")
    else {
      const sel = `[data-job-${f.kind}="${CSS.escape(f.id)}"]`
      el = root.querySelector(sel)
    }
    if (!el) return
    if (f.kind === "employer") {
      if (finePointer()) {
        el.focus()
        ;(el as HTMLInputElement).select?.()
      } else el.scrollIntoView({ block: "nearest" })
    } else el.focus()
  })

  // Errors open the cards that hold them.
  const errorKeys = Object.keys(errors)
  const hasErrors = errorKeys.some(
    (k) => k.startsWith("jobs") || k.startsWith("pay")
  )
  React.useEffect(() => {
    const ids: string[] = []
    for (const k of Object.keys(errors)) {
      const hit = /^jobs\[(\d+)\]/.exec(k)
      const job = hit ? bodyRef.current.jobs[Number(hit[1])] : null
      if (job) ids.push(job.id)
    }
    if (ids.length) setOpen((prev) => new Set([...prev, ...ids]))
  }, [errors])

  const jobs = body.jobs
  const windows = React.useMemo(() => jobWindows(jobs, months), [jobs, months])
  const baseById = new Map((base?.jobs ?? []).map((j) => [j.id, j]))
  const savedById = new Map((saved?.jobs ?? []).map((j) => [j.id, j]))
  const bodyIds = new Set(jobs.map((j) => j.id))

  // Body jobs in order, with jobs the scenario removed put back where the
  // plan has them.
  const rows: Row[] = jobs.map((job, index) => ({ kind: "job", job, index }))
  if (base) {
    base.jobs.forEach((bj, bi) => {
      if (bodyIds.has(bj.id)) return
      let at = 0
      for (let p = bi - 1; p >= 0; p--) {
        const prevId = base.jobs[p].id
        const r = rows.findIndex((x) => x.job.id === prevId)
        if (r >= 0) {
          at = r + 1
          break
        }
      }
      rows.splice(at, 0, { kind: "removed", job: bj })
    })
  }

  const tagOf = (job: Job): string | null => {
    if (!base) return null
    const bj = baseById.get(job.id)
    if (!bj) return "Added in scenario"
    return deepEqual(job, bj) ? null : "Changed in scenario"
  }
  const fromPlan = base
    ? jobs.filter((j) => tagOf(j) != null).length +
      rows.filter((r) => r.kind === "removed").length +
      (deepEqual(body.pay, base.pay) ? 0 : 1)
    : 0
  const unsaved =
    saved != null &&
    (!deepEqual(jobs, saved.jobs) || !deepEqual(body.pay, saved.pay))

  // Lane colors alternate by start order, so a job keeps its color in the
  // lanes, the card swatch and the scenario.
  const colorOf = new Map<string, string>()
  ;[...jobs].sort(cmpStart).forEach((j, i) => {
    colorOf.set(j.id, i % 2 ? "var(--job2)" : "var(--job1)")
  })

  const addJob = () => {
    const b = bodyRef.current
    const first = months[0] ?? thisMonth()
    const last = months.at(-1) ?? first
    const enabled = b.jobs.filter((j) => j.enabled)
    const latest = enabled.reduce<Job | null>(
      (a, j) => (a == null || (j.start ?? "") >= (a.start ?? "") ? j : a),
      null
    )
    let start = latest ? addMonths(latest.start ?? first, 6) : first
    if (start < first) start = first
    if (start > last) start = last
    const from = latest ?? b.jobs.at(-1)
    const gross = from ? (enabledSteps(from).at(-1)?.gross ?? 0) : 100000
    const id = newJobId(
      new Set([...b.jobs.map((j) => j.id), ...baseById.keys()])
    )
    const job: Job = {
      id,
      employer: "New job",
      start,
      leave: null,
      enabled: true,
      note: null,
      salary: [{ from: start, gross, enabled: true, note: null }],
      match: { type: "none" },
      vesting: null,
      hsaEmployer: null,
      schedule: null,
      deductions: null,
      withholding: null,
    }
    setCardOpen(id, true)
    focusRef.current = { kind: "employer", id }
    update((cur) => ({ ...cur, jobs: [...cur.jobs, job] }))
  }

  const removeJob = (id: string) => {
    const cur = bodyRef.current.jobs
    const i = cur.findIndex((j) => j.id === id)
    if (baseById.has(id)) focusRef.current = { kind: "restore", id }
    else if (cur[i + 1])
      focusRef.current = { kind: "header", id: cur[i + 1].id }
    else if (cur[i - 1])
      focusRef.current = { kind: "header", id: cur[i - 1].id }
    else focusRef.current = { kind: "add" }
    update((b) => ({ ...b, jobs: b.jobs.filter((j) => j.id !== id) }))
  }

  const restoreJob = (id: string) => {
    if (!base) return
    const bi = base.jobs.findIndex((j) => j.id === id)
    if (bi < 0) return
    focusRef.current = { kind: "header", id }
    update((b) => {
      if (b.jobs.some((j) => j.id === id)) return b
      let at = 0
      for (let p = bi - 1; p >= 0; p--) {
        const k = b.jobs.findIndex((j) => j.id === base.jobs[p].id)
        if (k >= 0) {
          at = k + 1
          break
        }
      }
      const next = [...b.jobs]
      next.splice(at, 0, structuredClone(base.jobs[bi]))
      return { ...b, jobs: next }
    })
  }

  // A lane segment opens its job's card and focuses that step's gross.
  const jumpTo = (id: string, step: number) => {
    setCardOpen(id, true)
    requestAnimationFrame(() => {
      const root = rootRef.current
      const card = root?.querySelector<HTMLElement>(
        `[data-job-card="${CSS.escape(id)}"]`
      )
      if (!card) return
      const input =
        step >= 0
          ? card.querySelector<HTMLInputElement>(
              `[data-step-index="${step}"] [data-step-gross] input`
            )
          : null
      const target =
        input ?? card.querySelector<HTMLElement>(`[data-job-header]`)
      if (input && !finePointer()) {
        // No keyboard pop on touch: bring the row into view instead.
        input.scrollIntoView({
          block: "nearest",
          behavior: reducedMotion() ? "auto" : "smooth",
        })
        return
      }
      card.scrollIntoView({
        block: "nearest",
        behavior: reducedMotion() ? "auto" : "smooth",
      })
      target?.focus({ preventScroll: true })
      if (input) input.select()
    })
  }

  // Errors at "jobs" or "pay" themselves, not under a job or a pay field.
  const looseErrors = errorKeys
    .filter((k) => k === "jobs" || k === "pay")
    .map((k) => errors[k])

  const badge =
    fromPlan > 0 || unsaved ? (
      <span className="inline-flex items-center gap-1.5">
        {fromPlan > 0 ? <RowTag>{fromPlan} from Plan</RowTag> : null}
        {unsaved ? (
          <RowTag>
            <span
              aria-hidden="true"
              className="mr-1 size-1.5 rounded-full bg-primary"
            />
            Unsaved
          </RowTag>
        ) : null}
      </span>
    ) : undefined

  return (
    <InputsSection
      title="Jobs and pay"
      hint="Who pays you and when. A job ends when you leave or when the next job starts."
      summary={sectionSummary(jobs, windows, months)}
      badge={badge}
      forceOpen={hasErrors}
    >
      <div
        ref={rootRef}
        className={cn(
          "flex min-w-0 flex-col gap-3 @md:col-span-2",
          LANE_TOKENS
        )}
      >
        {looseErrors.map((msg) => (
          <span key={msg} className={cn("text-xs", ERROR)} data-field-error="">
            {msg}
          </span>
        ))}
        {months.length && jobs.length ? (
          <JobLanes
            jobs={jobs}
            windows={windows}
            months={months}
            baseById={base ? baseById : null}
            colorOf={colorOf}
            onJump={jumpTo}
          />
        ) : null}

        {jobs.length === 0 && !rows.length ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center text-muted-foreground text-xs">
            No jobs. Without a job this plan has no paychecks.
            {readOnly ? null : (
              <Button
                variant="outline"
                size="sm"
                data-add-job=""
                onClick={addJob}
              >
                + Add job
              </Button>
            )}
          </div>
        ) : null}

        {rows.length ? (
          <div className="flex flex-col gap-2">
            {rows.map((r) =>
              r.kind === "removed" ? (
                <RemovedJobRow
                  key={r.job.id}
                  job={r.job}
                  readOnly={readOnly}
                  onRestore={() => restoreJob(r.job.id)}
                />
              ) : (
                <JobCard
                  key={r.job.id}
                  job={r.job}
                  index={r.index}
                  jobs={jobs}
                  windows={windows}
                  months={months}
                  pay={body.pay}
                  savedJob={saved ? (savedById.get(r.job.id) ?? null) : null}
                  baseJob={baseById.get(r.job.id) ?? null}
                  tag={tagOf(r.job)}
                  open={open.has(r.job.id)}
                  onOpenChange={(v) => setCardOpen(r.job.id, v)}
                  readOnly={readOnly}
                  errors={errors}
                  setJob={(fn) => setJob(r.job.id, fn)}
                  onRemove={() => removeJob(r.job.id)}
                />
              )
            )}
          </div>
        ) : null}

        {jobs.length > 0 && !readOnly ? (
          <AddButton data-add-job="" onClick={addJob}>
            Add job
          </AddButton>
        ) : null}

        <PayDefaults
          pay={body.pay}
          savedPay={saved?.pay ?? null}
          basePay={base?.pay ?? null}
          readOnly={readOnly}
          errors={errors}
          setPay={setPay}
        />
      </div>
    </InputsSection>
  )
}

// -------------------------------------------------------------------- lanes

/** One cell per calendar year: "’26" when a year has under 3 months. */
function yearBands(months: string[]) {
  const out: { year: string; from: number; n: number }[] = []
  months.forEach((m, i) => {
    const year = m.slice(0, 4)
    const last = out.at(-1)
    if (last && last.year === year) last.n += 1
    else out.push({ year, from: i, n: 1 })
  })
  return out
}

/** Width a mono 11px label needs, padding included. */
function labelWidth(text: string): number {
  return text.length * 6.7 + 12
}

function JobLanes({
  jobs,
  windows,
  months,
  baseById,
  colorOf,
  onJump,
}: {
  jobs: Job[]
  windows: JobWindow[]
  months: string[]
  baseById: Map<string, Job> | null
  colorOf: Map<string, string>
  onJump: (id: string, step: number) => void
}) {
  const n = months.length
  const idx = new Map(months.map((m, i) => [m, i]))
  const ref = React.useRef<HTMLDivElement>(null)
  // Label fitting needs the track width; measured before paint so labels
  // never pop in after the first frame.
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pxm = width / n

  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }
  const span = (from: number, count: number) => ({
    gridColumn: `${from + 1} / span ${count}`,
  })
  const range = (a: string, b: string) =>
    a === b ? monLong(a) : `${monLong(a)} to ${monLong(b)}`
  const janLines = months.flatMap((m, i) =>
    i > 0 && m.endsWith("-01")
      ? [
          <span
            key={m}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/15"
            style={{ left: `${(i / n) * 100}%` }}
          />,
        ]
      : []
  )

  const lanes = [...jobs].sort(cmpStart)

  // Caption: gross over the plan, raises, job changes.
  let total = 0
  let raises = 0
  let changes = 0
  let prevJob: Job | null = null
  let prevGross = 0
  let lastPaying: Job | null = null
  for (const m of months) {
    const j = activeJobAt(jobs, m)
    const g = j ? grossAt(j, m) : 0
    total += g / 12
    if (j && prevJob === j && g > prevGross) raises += 1
    if (j && lastPaying && lastPaying !== j) changes += 1
    if (j) lastPaying = j
    prevJob = j
    prevGross = g
  }

  return (
    <div
      role="group"
      aria-label="Who pays you, by month. Each bar is a job; each shade step is a salary change."
      className="flex min-w-0 flex-col gap-1"
    >
      <div ref={ref} className="grid" style={cols} aria-hidden="true">
        {yearBands(months).map((b, i) => (
          <span
            key={b.year}
            style={span(b.from, b.n)}
            className={cn(
              "relative overflow-hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground tabular-nums",
              i > 0 &&
                "pl-1.5 before:absolute before:top-0.5 before:bottom-px before:left-0 before:w-px before:bg-foreground/15"
            )}
          >
            {b.n >= 3 ? b.year : `’${b.year.slice(2)}`}
          </span>
        ))}
      </div>
      <div className="hidden @xl:grid" style={cols} aria-hidden="true">
        {months.map((m) => (
          <span
            key={m}
            className="text-center font-mono text-[10px] text-muted-foreground/75"
          >
            {monName(m).slice(0, 1)}
          </span>
        ))}
      </div>

      {lanes.map((job) => {
        const color = colorOf.get(job.id) ?? "var(--job1)"
        const name = job.employer || "Unnamed job"
        const baseJob = baseById?.get(job.id) ?? null
        const added = baseById != null && baseJob == null
        const mine = job.enabled
          ? windows.filter((w) => w.jobId === job.id)
          : []
        const gap = job.enabled ? gapAfter(job, windows) : null
        const end = job.enabled ? jobEnd(jobs, job, months) : null

        let cells: React.ReactNode
        if (!job.enabled || !mine.length) {
          cells = (
            <div
              className="flex h-full items-center rounded-md border border-foreground/15 border-dashed px-2 text-[11px] text-muted-foreground"
              style={{ gridColumn: "1 / -1" }}
            >
              {job.enabled
                ? "Pays nothing inside the plan"
                : "Off: not in this plan"}
            </div>
          )
        } else {
          cells = (
            <>
              {mine.map((w) => {
                const a = idx.get(w.from) ?? 0
                const b = idx.get(w.to) ?? a
                // Runs of the same salary step inside the window.
                const runs: { step: number; from: number; n: number }[] = []
                for (let i = a; i <= b; i++) {
                  const step = stepIndexAt(job, months[i])
                  const last = runs.at(-1)
                  if (last && last.step === step) last.n += 1
                  else runs.push({ step, from: i, n: 1 })
                }
                let prev = 0
                return (
                  <div
                    key={w.from}
                    className="flex h-full min-w-0 gap-0.5"
                    style={span(a, b - a + 1)}
                  >
                    {runs.map((r, ri) => {
                      const s = job.salary[r.step]
                      const g = s?.gross ?? 0
                      const up = prev ? ((g - prev) / prev) * 100 : null
                      prev = g
                      const label = usdShort(g)
                      const upText = up ? pctDelta(up) : ""
                      const w = r.n * pxm - 2
                      const need = labelWidth(label)
                      const needUp = need + upText.length * 6.2 + 5
                      const changed =
                        s != null && baseJob != null && stepChanged(s, baseJob)
                      const mix = Math.min(18 + ri * 14, 60)
                      const when = range(
                        months[r.from],
                        months[r.from + r.n - 1]
                      )
                      return (
                        <button
                          key={months[r.from]}
                          type="button"
                          onClick={() => onJump(job.id, r.step)}
                          aria-label={`${name}, ${usd(g)} a year, ${when}${changed ? ", changed in scenario" : ""}. Edit`}
                          title={`${name} · ${usd(g)}/yr · ${when}`}
                          style={{
                            flexGrow: r.n,
                            background: `color-mix(in oklab, ${color} ${mix}%, var(--card))`,
                          }}
                          className={cn(
                            "relative flex h-full min-w-0 shrink basis-0 touch-manipulation items-center gap-1 overflow-hidden whitespace-nowrap px-1.5 font-mono text-[11px] text-foreground tabular-nums transition-[filter] duration-150 ease-out first:rounded-l-md last:rounded-r-md hover:brightness-[1.08] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] motion-reduce:transition-none",
                            changed
                              ? "outline-1 outline-foreground outline-dashed -outline-offset-3"
                              : "outline-none"
                          )}
                        >
                          {w >= need ? label : null}
                          {w >= needUp && upText ? (
                            <span className="text-muted-foreground">
                              {upText}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
              {gap ? (
                <div
                  className="flex h-full items-center justify-center overflow-hidden whitespace-nowrap rounded-md text-[11px] text-muted-foreground"
                  style={{
                    ...span(
                      idx.get(gap.from) ?? 0,
                      (idx.get(gap.to) ?? 0) - (idx.get(gap.from) ?? 0) + 1
                    ),
                    backgroundImage: STRIPES,
                  }}
                  title={`No pay, ${range(gap.from, gap.to)}`}
                >
                  <span className="sr-only">
                    No pay, {range(gap.from, gap.to)}
                  </span>
                  {((idx.get(gap.to) ?? 0) - (idx.get(gap.from) ?? 0) + 1) *
                    pxm >
                  labelWidth("No pay") ? (
                    <span aria-hidden="true">No pay</span>
                  ) : null}
                </div>
              ) : null}
            </>
          )
        }

        // The end-of-job line: why the bar stops where it does.
        let endLine: React.ReactNode = null
        if (end && gap) {
          const count = (idx.get(gap.to) ?? 0) - (idx.get(gap.from) ?? 0) + 1
          endLine = (
            <span className={cn("inline-flex items-start gap-1", WARN)}>
              <AlertTriangle
                size={11}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              {`No pay for ${count} month${count === 1 ? "" : "s"}, ${
                gap.from === gap.to
                  ? monApos(gap.from)
                  : `${monApos(gap.from)} to ${monApos(gap.to)}`
              }${end.next ? `, until ${end.next.employer} starts` : ""}`}
            </span>
          )
        } else if (end?.next) {
          endLine =
            job.leave === end.last
              ? `Ends ${monLong(end.last)} (you leave)`
              : `Ends ${monLong(end.last)}, when ${end.next.employer} starts`
        }

        return (
          <div key={job.id} className="flex min-w-0 flex-col gap-1 pt-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: job.enabled ? color : "transparent" }}
              />
              <span
                className={cn(
                  "min-w-0 truncate font-medium",
                  !job.enabled && "text-muted-foreground"
                )}
              >
                {name}
              </span>
              {added ? <ScenarioTag>Added</ScenarioTag> : null}
              <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-muted-foreground tabular-nums">
                {job.enabled ? payText(job, windows, months) : "off"}
              </span>
            </div>
            <div className="relative h-[26px] rounded-md bg-muted">
              {janLines}
              <div className="absolute inset-0 grid" style={cols}>
                {cells}
              </div>
            </div>
            {endLine ? (
              <span className="text-[11px] text-muted-foreground">
                {endLine}
              </span>
            ) : null}
          </div>
        )
      })}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-[11px] text-muted-foreground">
        <span>
          Gross over the plan{" "}
          <span className="font-mono font-medium text-foreground tabular-nums">
            {usd(total)}
          </span>{" "}
          · {raises} raise{raises === 1 ? "" : "s"} · {changes} job change
          {changes === 1 ? "" : "s"}
        </span>
        <span>Tap a step to edit it.</span>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- job card

function RemovedJobRow({
  job,
  readOnly,
  onRestore,
}: {
  job: Job
  readOnly: boolean
  onRestore: () => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-foreground/10 md:min-h-9">
      <span className="min-w-0 truncate text-muted-foreground line-through opacity-70">
        {job.employer}
      </span>
      <RowTag>Removed in scenario</RowTag>
      {readOnly ? null : (
        <button
          type="button"
          data-job-restore={job.id}
          onClick={onRestore}
          className="relative ml-auto min-h-7 touch-manipulation font-medium text-foreground text-xs outline-none before:absolute before:-inset-x-1.5 before:-inset-y-1 focus-visible:underline active:scale-[0.97] pointer-coarse:before:-inset-y-2"
        >
          Restore
        </button>
      )}
    </div>
  )
}

/** The card's second line: dates with the reason, and any hint. */
function jobLine(
  job: Job,
  jobs: Job[],
  windows: JobWindow[],
  months: string[]
): { dates: string; hint?: string; gap?: string } {
  const first = months[0] ?? thisMonth()
  const before = job.start == null || job.start < first
  const s = before ? "Before plan" : monLong(job.start)
  if (!job.enabled)
    return {
      dates: job.leave
        ? `${s} to ${monLong(job.leave)}`
        : before
          ? "Whole plan"
          : `From ${monLong(job.start)}`,
      hint: "Off: not in this plan",
    }
  if (!paidRange(job, windows))
    return {
      dates: s,
      hint: "Pays nothing inside the plan: a later job covers it.",
    }
  const end = jobEnd(jobs, job, months)
  if (!end)
    return {
      dates: before
        ? job.leave
          ? `${s} to ${monLong(job.leave)}`
          : "Whole plan"
        : `From ${monLong(job.start)}`,
    }
  const dates = `${s} to ${monLong(end.last)}`
  if (end.gap) {
    const from = addMonths(end.last, 1)
    return {
      dates,
      gap: end.next?.start
        ? `No pay from ${monLong(from)} until ${end.next.employer} starts in ${monLong(end.next.start)}.`
        : `No pay after ${monLong(end.last)}.`,
    }
  }
  if (end.next && job.leave !== end.last)
    return { dates: `${dates}, when ${end.next.employer} starts` }
  return { dates }
}

function JobCard({
  job,
  index,
  jobs,
  windows,
  months,
  pay,
  savedJob,
  baseJob,
  tag,
  open,
  onOpenChange,
  readOnly,
  errors,
  setJob,
  onRemove,
}: {
  job: Job
  index: number
  jobs: Job[]
  windows: JobWindow[]
  months: string[]
  pay: Pay
  savedJob: Job | null
  baseJob: Job | null
  tag: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  readOnly: boolean
  errors: Record<string, string>
  setJob: (fn: (j: Job) => Job) => void
  onRemove: () => void
}) {
  const uid = React.useId()
  const fid = (k: string) => `${uid}-${k}`
  const path = `jobs[${index}]`
  const name = job.employer || "this job"
  const [touched, setTouched] = React.useState(false)

  const first = months[0] ?? thisMonth()
  const last = months.at(-1) ?? first
  const end = job.enabled ? jobEnd(jobs, job, months) : null
  const line = jobLine(job, jobs, windows, months)
  const range = paidRange(job, windows)
  const grossNow = grossAt(
    job,
    range?.from ?? (job.start && job.start > first ? job.start : first)
  )

  // The next enabled job by start, for the leave helper.
  const laterJob =
    end && !end.gap && end.next
      ? end.next
      : (jobs
          .filter(
            (j) =>
              j.enabled &&
              j.id !== job.id &&
              j.start != null &&
              j.start > (job.start ?? "")
          )
          .sort(cmpStart)[0] ?? null)

  const m = <K extends keyof Job>(k: K, fmt: (v: Job[K]) => string) =>
    marks(
      job[k],
      box(savedJob, (j) => j[k]),
      box(baseJob, (j) => j[k]),
      (v) => setJob((j) => ({ ...j, [k]: v })),
      fmt
    )
  const jobEdited = savedJob != null && !deepEqual(job, savedJob)

  const employerError =
    errors[`${path}.employer`] ??
    (touched && !job.employer.trim() ? "Name the employer." : undefined)
  const leaveError =
    errors[`${path}.leave`] ??
    (job.leave && job.start && job.leave < job.start
      ? "Leave is before start."
      : undefined)
  const otherErrors = Object.entries(errors).filter(([k]) => {
    if (!k.startsWith(path)) return false
    const rest = k.slice(path.length)
    if (rest === "") return true
    if (rest[0] !== "." && rest[0] !== "[") return false
    const field = /^\.([A-Za-z]+)/.exec(rest)?.[1]
    return !field || !JOB_FIELDS.includes(field)
  })

  const bodyId = fid("body")
  const dim = !job.enabled && "opacity-55"
  return (
    <div
      data-job-card={job.id}
      className={cn(
        "@container flex scroll-mt-14 flex-col rounded-lg ring-1",
        open ? "ring-foreground/15" : "ring-foreground/10"
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-xs">
        <HitToggle
          checked={job.enabled}
          onChange={(v) => setJob((j) => ({ ...j, enabled: v }))}
          label={`Include ${name}`}
        />
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            data-job-header={job.id}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => onOpenChange(!open)}
            className="flex min-h-9 min-w-0 touch-manipulation items-center gap-1 rounded-sm text-left font-medium outline-none hover:underline hover:decoration-foreground/20 hover:underline-offset-[3px] focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-7"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                open && "rotate-90"
              )}
            />
            <span className={cn("truncate", dim)}>
              {job.employer || "Unnamed job"}
            </span>
          </button>
          {jobEdited ? (
            <EditedDot
              label={`Unsaved changes to ${name}. Reset this job.`}
              onReset={() =>
                savedJob && setJob(() => structuredClone(savedJob))
              }
            />
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-right font-mono tabular-nums",
            dim
          )}
        >
          {payText(job, windows, months)}
        </span>
        <div className="col-start-2 col-end-[-1] -mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
          {tag ? <ScenarioTag>{tag}</ScenarioTag> : null}
          <span>{line.dates}</span>
          {line.hint ? <span>{line.hint}</span> : null}
          {line.gap ? (
            <span
              className={cn("inline-flex basis-full items-start gap-1", WARN)}
            >
              <AlertTriangle
                size={12}
                aria-hidden="true"
                className="mt-px shrink-0"
              />
              {line.gap}
            </span>
          ) : null}
        </div>
      </div>

      {open ? (
        <div
          id={bodyId}
          className="flex flex-col gap-4 border-t px-3 pt-3.5 pb-3"
        >
          <div className={cn("grid gap-x-4 gap-y-3 @md:grid-cols-2", dim)}>
            <Field
              id={fid("employer")}
              label="Employer"
              className="@md:col-span-2"
              {...m("employer", (v) => v || "unnamed")}
              error={employerError}
            >
              <input
                id={fid("employer")}
                data-job-employer={job.id}
                value={job.employer}
                disabled={readOnly}
                required
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                aria-invalid={employerError ? true : undefined}
                onChange={(e) =>
                  setJob((j) => ({ ...j, employer: e.target.value }))
                }
                onBlur={() => setTouched(true)}
                className={TEXT_INPUT}
              />
            </Field>

            <Field
              id={fid("start")}
              label="Start"
              {...m("start", (v) => (v ? monLong(v) : "before plan"))}
              error={errors[`${path}.start`]}
            >
              <Lock disabled={readOnly || job.start == null}>
                {job.start == null ? (
                  <input
                    id={fid("start")}
                    value="Before the plan"
                    disabled
                    className={cn(TEXT_INPUT, "text-muted-foreground")}
                  />
                ) : (
                  <MonthField
                    id={fid("start")}
                    ariaLabel={`${name} start month`}
                    value={job.start}
                    max={last}
                    onChange={(start) => setJob((j) => ({ ...j, start }))}
                  />
                )}
              </Lock>
              {index === 0 || job.start == null ? (
                <Lock disabled={readOnly}>
                  <CheckRow
                    checked={job.start == null}
                    onChange={(v) =>
                      setJob((j) => ({ ...j, start: v ? null : first }))
                    }
                  >
                    Already working here
                  </CheckRow>
                </Lock>
              ) : null}
            </Field>

            <Field
              id={fid("leave")}
              label="Leave (optional)"
              {...m("leave", (v) => (v ? monLong(v) : "open"))}
              error={leaveError}
            >
              <Lock disabled={readOnly} className="flex items-center gap-1">
                <MonthField
                  id={fid("leave")}
                  ariaLabel={`${name} leave month`}
                  value={job.leave ?? ""}
                  min={job.start ?? undefined}
                  onChange={(leave) => setJob((j) => ({ ...j, leave }))}
                />
                {job.leave && !readOnly ? (
                  <IconButton
                    label="Clear leave month"
                    className="ml-1"
                    onClick={() => setJob((j) => ({ ...j, leave: null }))}
                  >
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                ) : null}
              </Lock>
              {!job.leave && !leaveError ? (
                <span className="text-muted-foreground text-xs">
                  {laterJob?.start
                    ? `Ends when ${laterJob.employer} starts (${monLong(laterJob.start)})`
                    : "Open: runs to the end of the plan"}
                </span>
              ) : null}
            </Field>
          </div>

          <div className={cn("flex min-w-0 flex-col gap-1.5", dim)}>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-medium">Salary</span>
              <span className="text-muted-foreground">annual gross</span>
              <Markers {...m("salary", salaryText)} />
            </div>
            <SalarySteps
              steps={job.salary}
              baseJob={baseJob}
              jobStart={job.start}
              months={months}
              who={name}
              readOnly={readOnly}
              errors={errors}
              path={`${path}.salary`}
              onChange={(fn) => setJob((j) => ({ ...j, salary: fn(j.salary) }))}
            />
          </div>

          <div className={cn("flex min-w-0 flex-col gap-1.5", dim)}>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-medium">401k match</span>
              <Markers {...m("match", matchText)} />
            </div>
            <MatchEditor
              value={job.match}
              grossNow={grossNow}
              readOnly={readOnly}
              onChange={(match) => setJob((j) => ({ ...j, match }))}
            />
            {errUnder(errors, `${path}.match`) ? (
              <span className={cn("text-xs", ERROR)}>
                {errUnder(errors, `${path}.match`)}
              </span>
            ) : null}
          </div>

          <div className={cn("min-w-0", dim)}>
            <JobPayOverrides
              job={job}
              pay={pay}
              savedJob={savedJob}
              baseJob={baseJob}
              readOnly={readOnly}
              errors={errors}
              path={path}
              setJob={setJob}
            />
          </div>

          {otherErrors.map(([k, msg]) => (
            <span key={k} className={cn("text-xs", ERROR)} data-field-error="">
              {msg}
            </span>
          ))}

          {readOnly ? null : (
            <div className="-mt-1 flex justify-end border-t pt-2">
              <button
                type="button"
                onClick={onRemove}
                className="relative inline-flex min-h-9 touch-manipulation items-center text-rose-600 text-xs underline-offset-2 outline-none before:absolute before:-inset-x-1.5 before:-inset-y-1 hover:underline focus-visible:underline active:scale-[0.97] md:min-h-7 dark:text-rose-400"
              >
                Remove {job.employer || "this job"}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------- salary steps

function SalarySteps({
  steps,
  baseJob,
  jobStart,
  months,
  who,
  readOnly,
  errors,
  path,
  onChange,
}: {
  steps: SalaryStep[]
  baseJob: Job | null
  jobStart: string | null
  months: string[]
  who: string
  readOnly: boolean
  errors: Record<string, string>
  path: string
  onChange: Updater<SalaryStep[]>
}) {
  const lk = useLocalKeys(steps.length)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const focusRef = React.useRef<{
    key: string
    what: "gross" | "remove" | "add"
  } | null>(null)
  React.useEffect(() => {
    const f = focusRef.current
    const root = rootRef.current
    if (!f || !root) return
    focusRef.current = null
    const el =
      f.what === "add"
        ? root.querySelector<HTMLElement>("[data-add-step]")
        : root.querySelector<HTMLElement>(
            `[data-step="${f.key}"] [data-step-${f.what}]`
          )
    if (!el) return
    // The gross marker wraps the field; focus its input.
    const target = el.matches("input, button")
      ? el
      : (el.querySelector<HTMLElement>("input") ?? el)
    if (f.what === "gross" && !finePointer())
      target.scrollIntoView({ block: "nearest" })
    else target.focus()
  })

  const set = (i: number, patch: Partial<SalaryStep>) =>
    onChange((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  // Re-sort only when focus leaves a row, so a row never jumps mid-edit.
  const sortSteps = () =>
    onChange((prev) => {
      const order = prev.map((_, i) => i)
      order.sort((a, b) =>
        prev[a].from < prev[b].from
          ? -1
          : prev[a].from > prev[b].from
            ? 1
            : a - b
      )
      if (order.every((v, i) => v === i)) return prev
      lk.permute(order)
      return order.map((i) => prev[i])
    })

  const add = () => {
    const sorted = [...steps].sort((a, b) => (a.from < b.from ? -1 : 1))
    const lastStep = sorted.at(-1)
    const end = months.at(-1)
    let from = lastStep
      ? addMonths(lastStep.from, 12)
      : (jobStart ?? months[0] ?? thisMonth())
    if (end && from > end) from = end
    const key = lk.append()
    focusRef.current = { key, what: "gross" }
    onChange((prev) => [
      ...prev,
      { from, gross: lastStep?.gross ?? 0, enabled: true, note: "Raise" },
    ])
  }

  const remove = (i: number) => {
    const keys = lk.keys
    focusRef.current =
      keys[i + 1] != null
        ? { key: keys[i + 1], what: "remove" }
        : keys[i - 1] != null
          ? { key: keys[i - 1], what: "remove" }
          : { key: "", what: "add" }
    lk.remove(i)
    onChange((prev) => prev.filter((_, j) => j !== i))
  }

  // Inline problems: two steps in one month; no salary at the job's start.
  const seen = new Map<string, number>()
  const dupAt = new Set<number>()
  steps.forEach((s, i) => {
    if (seen.has(s.from)) dupAt.add(i)
    else seen.set(s.from, i)
  })
  // Change from the previous enabled step, in month order.
  const delta = new Map<number, number>()
  {
    const order = steps
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.enabled)
      .sort((a, b) => (a.s.from < b.s.from ? -1 : a.s.from > b.s.from ? 1 : 0))
    order.forEach((x, k) => {
      const p = order[k - 1]
      if (p && p.s.gross > 0)
        delta.set(x.i, ((x.s.gross - p.s.gross) / p.s.gross) * 100)
    })
  }
  const firstOn = enabledSteps({ salary: steps } as Job)[0]
  const effStart =
    jobStart == null || (months[0] && jobStart < months[0])
      ? (months[0] ?? jobStart)
      : jobStart
  const gapWarning =
    firstOn && effStart && firstOn.from > effStart
      ? (() => {
          const lastUnpaid = addMonths(firstOn.from, -1)
          const sameYear = effStart.slice(0, 4) === lastUnpaid.slice(0, 4)
          const fmt = (x: string) => (sameYear ? monName(x) : monLong(x))
          const span =
            effStart === lastUnpaid
              ? `in ${fmt(effStart)}`
              : `from ${fmt(effStart)} to ${fmt(lastUnpaid)}`
          return `No salary before ${monLong(firstOn.from)}: the job pays nothing ${span}.`
        })()
      : null

  // Narrow: [check] [month] [change] [x], then gross, then note.
  // From 30rem: one row, with column headers.
  const grid =
    "grid grid-cols-[20px_minmax(0,1fr)_3.4rem_24px] items-center gap-x-2 gap-y-1.5 @[30rem]:grid-cols-[20px_9.25rem_minmax(6.5rem,1fr)_3.4rem_minmax(0,1fr)_24px]"

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
      <div
        aria-hidden="true"
        className={cn(
          grid,
          "hidden text-[11px] text-muted-foreground @[30rem]:grid"
        )}
      >
        <span />
        <span>From</span>
        <span className="text-right">Annual gross</span>
        <span className="text-right">Change</span>
        <span>Note</span>
      </div>
      {steps.map((s, i) => {
        const k = lk.keys[i]
        const when = monLong(s.from)
        const err =
          errUnder(errors, `${path}[${i}]`) ??
          (dupAt.has(i) ? `Two steps start in ${when}.` : undefined)
        const only = steps.length <= 1
        const d = delta.get(i)
        const before = months[0] != null && s.from < months[0]
        // In a scenario: the plan's gross for the same month, when it differs.
        const planStep =
          baseJob?.salary.find((b) => b.from === s.from && b.enabled) ?? null
        const planGross =
          planStep && planStep.gross !== s.gross ? planStep.gross : null
        const off = !s.enabled && "opacity-50"
        return (
          <div
            key={k}
            data-step={k}
            data-step-index={i}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                sortSteps()
            }}
            className={cn(
              grid,
              i > 0 && "border-t pt-2 @[30rem]:border-t-0 @[30rem]:pt-0"
            )}
          >
            <label
              title="Include this step"
              className="relative col-start-1 row-start-1 grid h-9 w-5 cursor-pointer place-items-center before:absolute before:inset-y-0 before:-inset-x-1 md:h-7"
            >
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={readOnly}
                aria-label={`Include ${when} step`}
                onChange={(e) => set(i, { enabled: e.target.checked })}
                className="relative size-4 cursor-pointer accent-primary md:size-3.5"
              />
            </label>
            <div
              className={cn(
                "col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5",
                off
              )}
            >
              <Lock disabled={readOnly}>
                <MonthField
                  ariaLabel={`${who} salary step month`}
                  value={s.from}
                  onChange={(from) => set(i, { from })}
                />
              </Lock>
              {before ? (
                <span className="text-[11px] text-muted-foreground">
                  before plan
                </span>
              ) : null}
            </div>
            <Lock
              disabled={readOnly}
              className={cn(
                "col-start-2 col-end-[-1] row-start-2 @[30rem]:col-start-3 @[30rem]:col-end-auto @[30rem]:row-start-1 @[30rem]:self-start",
                off
              )}
            >
              <span data-step-gross="" className="contents">
                <NumberField
                  ariaLabel={`Annual gross from ${when}`}
                  prefix="$"
                  suffix="/yr"
                  className={FIELD}
                  value={s.gross}
                  onChange={(v) => set(i, { gross: Math.max(0, v) })}
                />
              </span>
            </Lock>
            <span
              className={cn(
                "col-start-3 row-start-1 text-right font-mono text-[11px] tabular-nums @[30rem]:col-start-4",
                d != null && d > 0
                  ? "text-foreground"
                  : "text-muted-foreground",
                off
              )}
            >
              <span aria-hidden="true">
                {d != null ? pctDelta(d) : s.enabled ? "start" : "off"}
              </span>
              {d != null ? (
                <span className="sr-only">
                  {pctDelta(d)} from the step before
                </span>
              ) : null}
            </span>
            <Lock
              disabled={readOnly}
              className={cn(
                "col-start-2 col-end-[-1] row-start-3 @[30rem]:col-start-5 @[30rem]:col-end-auto @[30rem]:row-start-1 @[30rem]:self-start",
                off
              )}
            >
              <input
                aria-label={`Note for ${when} step`}
                placeholder="Note"
                value={s.note ?? ""}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                onChange={(e) => set(i, { note: e.target.value || null })}
                className={cn(TEXT_INPUT, "w-full")}
              />
            </Lock>
            {readOnly ? (
              <span className="col-start-4 row-start-1 @[30rem]:col-start-6" />
            ) : (
              <IconButton
                data-step-remove=""
                label={
                  only
                    ? `Remove ${when} step (a job needs at least one salary)`
                    : `Remove ${when} step`
                }
                title={only ? "A job needs at least one salary" : undefined}
                disabled={only}
                className="col-start-4 row-start-1 @[30rem]:col-start-6"
                onClick={() => remove(i)}
              >
                <X size={12} aria-hidden="true" />
              </IconButton>
            )}
            {planGross != null || err ? (
              <div className="col-start-2 col-end-[-1] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                {planGross != null ? (
                  <FallbackReset
                    source="Plan"
                    text={usd(planGross)}
                    onReset={() => set(i, { gross: planGross })}
                  />
                ) : null}
                {err ? (
                  <span className={ERROR} data-field-error="">
                    {err}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
      {gapWarning ? (
        <span className={cn("inline-flex items-start gap-1 text-xs", WARN)}>
          <AlertTriangle
            size={12}
            aria-hidden="true"
            className="mt-px shrink-0"
          />
          {gapWarning}
        </span>
      ) : null}
      {readOnly ? null : (
        <AddButton data-add-step="" onClick={add}>
          Add salary step
        </AddButton>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- match

const MATCH_DEFAULTS: Record<Match["type"], Match> = {
  none: { type: "none" },
  flat: { type: "flat", pct: 0.04 },
  threshold: { type: "threshold", minPct: 0.05, pct: 0.04 },
  tiered: {
    type: "tiered",
    tiers: [
      { rate: 1, upToPct: 0.03 },
      { rate: 0.5, upToPct: 0.05 },
    ],
  },
}

/** The match in one sentence, plus the most it can add (share of pay). */
function matchSentence(m: Match): { text: string; max: number } {
  switch (m.type) {
    case "none":
      return { text: "No employer match.", max: 0 }
    case "flat":
      return {
        text: `Employer adds ${pctPlain(m.pct)} of pay, whatever you put in.`,
        max: m.pct,
      }
    case "threshold":
      return {
        text: `Employer adds ${pctPlain(m.pct)} of pay once you put in at least ${pctPlain(m.minPct)}.`,
        max: m.pct,
      }
    case "tiered": {
      let prev = 0
      let max = 0
      const bits = m.tiers.map((t, i) => {
        const w = Math.max(0, t.upToPct - prev)
        max += t.rate * w
        prev = Math.max(prev, t.upToPct)
        return i === 0
          ? `${pctPlain(t.rate)} of the first ${pctPlain(w)}`
          : `${pctPlain(t.rate)} of the next ${pctPlain(w)}`
      })
      return {
        text: `Employer matches ${bits.join(", then ")} you put in.`,
        max,
      }
    }
  }
}

function MatchEditor({
  value,
  grossNow,
  readOnly,
  onChange,
}: {
  value: Match
  /** Annual gross the dollar estimate uses: the first paid month's. */
  grossNow: number
  readOnly: boolean
  onChange: (m: Match) => void
}) {
  const uid = React.useId()
  // Each type's last values, so flipping types and back loses nothing.
  const stash = React.useRef<Partial<Record<Match["type"], Match>>>({})
  stash.current[value.type] = value
  const tierCount = value.type === "tiered" ? value.tiers.length : 0
  const lk = useLocalKeys(tierCount)
  const info = matchSentence(value)

  return (
    <Lock disabled={readOnly} className="flex flex-col gap-2">
      <Segmented
        ariaLabel="401k match type"
        className="h-9 w-full @md:w-fit md:h-7"
        optionClassName="flex-1"
        value={value.type}
        options={[
          { value: "none", label: "None" },
          { value: "flat", label: "Flat" },
          { value: "threshold", label: "Threshold" },
          { value: "tiered", label: "Tiered" },
        ]}
        onChange={(type) =>
          onChange(stash.current[type] ?? structuredClone(MATCH_DEFAULTS[type]))
        }
      />
      {value.type === "flat" ? (
        <Field
          id={`${uid}-flat`}
          label="Employer adds"
          className="@md:max-w-[50%]"
        >
          <NumberField
            id={`${uid}-flat`}
            ariaLabel="Employer adds, percent of pay"
            suffix="% of pay"
            className={FIELD}
            value={pctIn(value.pct)}
            onChange={(v) => onChange({ ...value, pct: Math.max(0, v) / 100 })}
          />
        </Field>
      ) : null}
      {value.type === "threshold" ? (
        <div className="grid gap-x-4 gap-y-3 @md:grid-cols-2">
          <Field id={`${uid}-min`} label="You put in at least">
            <NumberField
              id={`${uid}-min`}
              ariaLabel="You put in at least, percent of pay"
              suffix="%"
              className={FIELD}
              value={pctIn(value.minPct)}
              onChange={(v) =>
                onChange({ ...value, minPct: Math.max(0, v) / 100 })
              }
            />
          </Field>
          <Field id={`${uid}-pct`} label="Employer adds">
            <NumberField
              id={`${uid}-pct`}
              ariaLabel="Employer adds, percent of pay"
              suffix="% of pay"
              className={FIELD}
              value={pctIn(value.pct)}
              onChange={(v) =>
                onChange({ ...value, pct: Math.max(0, v) / 100 })
              }
            />
          </Field>
        </div>
      ) : null}
      {value.type === "tiered" ? (
        <div className="flex flex-col gap-2">
          {value.tiers.map((t, i) => {
            const setTier = (patch: Partial<typeof t>) =>
              onChange({
                ...value,
                tiers: value.tiers.map((x, j) =>
                  j === i ? { ...x, ...patch } : x
                ),
              })
            return (
              <div
                key={lk.keys[i]}
                className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_24px] items-center gap-2 text-xs"
              >
                <NumberField
                  ariaLabel={`Tier ${i + 1} match rate`}
                  suffix="%"
                  className={FIELD}
                  value={pctIn(t.rate)}
                  onChange={(v) => setTier({ rate: Math.max(0, v) / 100 })}
                />
                <span className="whitespace-nowrap text-muted-foreground">
                  match on pay up to
                </span>
                <NumberField
                  ariaLabel={`Tier ${i + 1} applies up to, percent of pay`}
                  suffix="%"
                  className={FIELD}
                  value={pctIn(t.upToPct)}
                  onChange={(v) => setTier({ upToPct: Math.max(0, v) / 100 })}
                />
                {readOnly ? (
                  <span />
                ) : (
                  <IconButton
                    label={`Remove tier ${i + 1}`}
                    disabled={value.tiers.length <= 1}
                    title={
                      value.tiers.length <= 1
                        ? "A tiered match needs at least one tier"
                        : undefined
                    }
                    onClick={() => {
                      lk.remove(i)
                      onChange({
                        ...value,
                        tiers: value.tiers.filter((_, j) => j !== i),
                      })
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                )}
              </div>
            )
          })}
          {readOnly ? null : (
            <AddButton
              onClick={() => {
                const lastTier = value.tiers.at(-1)
                lk.append()
                onChange({
                  ...value,
                  tiers: [
                    ...value.tiers,
                    {
                      rate: 0.5,
                      upToPct: Number(
                        ((lastTier?.upToPct ?? 0) + 0.02).toFixed(4)
                      ),
                    },
                  ],
                })
              }}
            >
              Add tier
            </AddButton>
          )}
        </div>
      ) : null}
      <p className="m-0 text-pretty text-muted-foreground text-xs">
        {info.text}
        {info.max > 0 && grossNow > 0 ? (
          <>
            {" "}
            Up to{" "}
            <span className="font-mono text-foreground tabular-nums">
              {pctPlain(info.max)}
            </span>{" "}
            of pay, about{" "}
            <span className="font-mono text-foreground tabular-nums">
              {usd(grossNow * info.max)}
            </span>{" "}
            a year at {usdShort(grossNow)}.
          </>
        ) : null}
      </p>
    </Lock>
  )
}

// ------------------------------------------------------------ pay overrides

/** A disclosure row: chevron, title, a one-line summary; body below. */
function Disclosure({
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onOpenChange: (v: boolean) => void
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <div className="min-w-0 border-t pt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
        className="group grid min-h-9 w-full touch-manipulation grid-cols-[12px_auto_minmax(0,1fr)] items-baseline gap-x-1.5 rounded-sm py-1.5 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-8"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn(
            "translate-y-0.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
        <span className="whitespace-nowrap font-medium group-hover:underline group-hover:decoration-foreground/20 group-hover:underline-offset-[3px]">
          {title}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {summary}
        </span>
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-3.5 pt-1.5 pb-1 pl-[18px]">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** One override item: "Default: ..." with [Override], or the editor with
 * "Use pay default". */
function OverrideItem({
  label,
  overridden,
  defaultText,
  markers,
  readOnly,
  onOverride,
  onUseDefault,
  overrideLabel = "Override",
  defaultLabel = "Use pay default",
  children,
}: {
  label: string
  overridden: boolean
  defaultText: string
  markers: React.ComponentProps<typeof Markers>
  readOnly: boolean
  onOverride: () => void
  onUseDefault: () => void
  overrideLabel?: string
  defaultLabel?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium">{label}</span>
        <Markers {...markers} />
        {overridden ? null : (
          <span className="min-w-0 text-muted-foreground">{defaultText}</span>
        )}
        {readOnly ? null : overridden ? (
          <button
            type="button"
            className="relative ml-auto inline-flex min-h-9 shrink-0 touch-manipulation items-center text-muted-foreground text-xs underline-offset-2 outline-none before:absolute before:-inset-x-1.5 before:-inset-y-1 hover:text-foreground focus-visible:underline active:scale-[0.97] md:min-h-7"
            onClick={onUseDefault}
          >
            {defaultLabel}
          </button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto h-9 md:h-7"
            onClick={onOverride}
          >
            {overrideLabel}
          </Button>
        )}
      </div>
      {overridden ? (
        <div className="flex flex-col gap-2.5 border-l-2 pl-2.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function JobPayOverrides({
  job,
  pay,
  savedJob,
  baseJob,
  readOnly,
  errors,
  path,
  setJob,
}: {
  job: Job
  pay: Pay
  savedJob: Job | null
  baseJob: Job | null
  readOnly: boolean
  errors: Record<string, string>
  path: string
  setJob: (fn: (j: Job) => Job) => void
}) {
  const errorInside = [
    "schedule",
    "deductions",
    "withholding",
    "hsaEmployer",
  ].some((k) => errUnder(errors, `${path}.${k}`))
  const [open, setOpen] = React.useState(errorInside)
  React.useEffect(() => {
    if (errorInside) setOpen(true)
  }, [errorInside])

  const overrides = [
    job.schedule ? "pay schedule" : null,
    job.deductions ? "deductions" : null,
    job.withholding ? "withholding" : null,
  ].filter(Boolean)
  const summary = [
    overrides.length ? `Own ${overrides.join(", ")}` : "Uses your pay defaults",
    job.hsaEmployer ? "HSA employer money" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const m = <
    K extends "schedule" | "deductions" | "withholding" | "hsaEmployer",
  >(
    k: K,
    fmt: (v: Job[K]) => string
  ) =>
    marks(
      job[k],
      box(savedJob, (j) => j[k]),
      box(baseJob, (j) => j[k]),
      (v) => setJob((j) => ({ ...j, [k]: v })),
      fmt
    )

  return (
    <Disclosure
      title="Pay overrides"
      summary={summary}
      open={open}
      onOpenChange={setOpen}
    >
      <OverrideItem
        label="Pay schedule"
        overridden={job.schedule != null}
        defaultText={`Default: ${capitalize(scheduleText(pay.schedule))}`}
        markers={m("schedule", (v: PaySchedule | null) =>
          v ? scheduleText(v) : "pay default"
        )}
        readOnly={readOnly}
        onOverride={() =>
          setJob((j) => ({
            ...j,
            schedule: structuredClone(pay.schedule ?? DEFAULT_SCHEDULE),
          }))
        }
        onUseDefault={() => setJob((j) => ({ ...j, schedule: null }))}
      >
        {job.schedule ? (
          <ScheduleEditor
            value={job.schedule}
            readOnly={readOnly}
            errors={errors}
            path={`${path}.schedule`}
            onChange={(schedule) => setJob((j) => ({ ...j, schedule }))}
          />
        ) : null}
      </OverrideItem>

      <OverrideItem
        label="Deductions"
        overridden={job.deductions != null}
        defaultText={`Default: ${capitalize(deductionsText(pay.deductions))}`}
        markers={m("deductions", (v: Deduction[] | null) =>
          v ? deductionsText(v) : "pay default"
        )}
        readOnly={readOnly}
        onOverride={() =>
          setJob((j) => ({ ...j, deductions: structuredClone(pay.deductions) }))
        }
        onUseDefault={() => setJob((j) => ({ ...j, deductions: null }))}
      >
        {job.deductions ? (
          <DeductionsEditor
            value={job.deductions}
            readOnly={readOnly}
            errors={errors}
            path={`${path}.deductions`}
            onChange={(fn) =>
              setJob((j) => ({ ...j, deductions: fn(j.deductions ?? []) }))
            }
          />
        ) : null}
      </OverrideItem>

      <OverrideItem
        label="Withholding"
        overridden={job.withholding != null}
        defaultText={`Default: ${capitalize(withholdingText(pay.withholding))}`}
        markers={m("withholding", (v: Withholding | null) =>
          v ? withholdingText(v) : "pay default"
        )}
        readOnly={readOnly}
        onOverride={() =>
          setJob((j) => ({
            ...j,
            withholding: structuredClone(pay.withholding),
          }))
        }
        onUseDefault={() => setJob((j) => ({ ...j, withholding: null }))}
      >
        {job.withholding ? (
          <WithholdingEditor
            value={job.withholding}
            saved={savedJob?.withholding ?? null}
            base={baseJob?.withholding ?? null}
            readOnly={readOnly}
            errors={errors}
            path={`${path}.withholding`}
            onChange={(fn) =>
              setJob((j) => ({
                ...j,
                withholding: fn(j.withholding ?? pay.withholding),
              }))
            }
          />
        ) : null}
      </OverrideItem>

      <OverrideItem
        label="HSA employer money"
        overridden={job.hsaEmployer != null}
        defaultText="None"
        overrideLabel="Add"
        defaultLabel="Remove"
        markers={m("hsaEmployer", (v) =>
          v
            ? `${usdShort(v.amount)} in ${monName(`2000-${String(v.month).padStart(2, "0")}`)}`
            : "none"
        )}
        readOnly={readOnly}
        onOverride={() =>
          setJob((j) => ({ ...j, hsaEmployer: { amount: 0, month: 1 } }))
        }
        onUseDefault={() => setJob((j) => ({ ...j, hsaEmployer: null }))}
      >
        {job.hsaEmployer ? (
          <HsaEmployerEditor
            value={job.hsaEmployer}
            readOnly={readOnly}
            errors={errors}
            path={`${path}.hsaEmployer`}
            onChange={(hsaEmployer) => setJob((j) => ({ ...j, hsaEmployer }))}
          />
        ) : null}
      </OverrideItem>
    </Disclosure>
  )
}

// ------------------------------------------------------------- pay defaults

function PayDefaults({
  pay,
  savedPay,
  basePay,
  readOnly,
  errors,
  setPay,
}: {
  pay: Pay
  savedPay: Pay | null
  basePay: Pay | null
  readOnly: boolean
  errors: Record<string, string>
  setPay: Updater<Pay>
}) {
  const errorInside = Object.keys(errors).some((k) => k.startsWith("pay."))
  const [open, setOpen] = React.useState(errorInside)
  React.useEffect(() => {
    if (errorInside) setOpen(true)
  }, [errorInside])

  const summary = `${capitalize(scheduleText(pay.schedule))} · ${deductionsText(
    pay.deductions
  )} · ${withholdingText(pay.withholding)}`

  const m = <K extends keyof Pay>(k: K, fmt: (v: Pay[K]) => string) =>
    marks(
      pay[k],
      box(savedPay, (p) => p[k]),
      box(basePay, (p) => p[k]),
      (v) => setPay((p) => ({ ...p, [k]: v })),
      fmt
    )
  const label = "text-xs font-medium"
  const otherErrors = Object.entries(errors).filter(
    ([k]) =>
      k.startsWith("pay.") &&
      !/^pay\.(schedule|deductions|withholding)\b/.test(k)
  )

  return (
    <Disclosure
      title="Pay defaults"
      summary={summary}
      open={open}
      onOpenChange={setOpen}
    >
      <p className="m-0 text-muted-foreground text-xs">
        Every job uses these unless it overrides them.
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={label}>Pay schedule</span>
          <Markers {...m("schedule", scheduleText)} />
        </div>
        {pay.schedule ? (
          <ScheduleEditor
            value={pay.schedule}
            readOnly={readOnly}
            errors={errors}
            path="pay.schedule"
            onChange={(schedule) => setPay((p) => ({ ...p, schedule }))}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            Not set: every job sets its own.
            {readOnly ? null : (
              <Button
                variant="outline"
                size="xs"
                className="h-9 md:h-7"
                onClick={() =>
                  setPay((p) => ({
                    ...p,
                    schedule: structuredClone(DEFAULT_SCHEDULE),
                  }))
                }
              >
                Set a default
              </Button>
            )}
            {errors["pay.schedule"] ? (
              <span className={ERROR}>{errors["pay.schedule"]}</span>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={label}>Deductions</span>
          <Markers {...m("deductions", deductionsText)} />
        </div>
        <DeductionsEditor
          value={pay.deductions}
          readOnly={readOnly}
          errors={errors}
          path="pay.deductions"
          onChange={(fn) =>
            setPay((p) => ({ ...p, deductions: fn(p.deductions) }))
          }
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className={label}>Withholding</span>
        <WithholdingEditor
          value={pay.withholding}
          saved={savedPay?.withholding ?? null}
          base={basePay?.withholding ?? null}
          readOnly={readOnly}
          errors={errors}
          path="pay.withholding"
          onChange={(fn) =>
            setPay((p) => ({ ...p, withholding: fn(p.withholding) }))
          }
        />
      </div>

      {otherErrors.map(([k, msg]) => (
        <span key={k} className={cn("text-xs", ERROR)} data-field-error="">
          {msg}
        </span>
      ))}
    </Disclosure>
  )
}
