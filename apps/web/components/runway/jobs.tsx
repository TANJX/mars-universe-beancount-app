"use client"

// "Jobs and pay": who pays the person and when. A timeline of the job
// windows over the horizon, one card per job (dates, salary steps, 401k
// match, pay overrides) and the person's pay defaults at the bottom.
//
// Windows and hints come from lib/runway/jobs.ts, the same resolver the
// engine uses, so the timeline always matches the paychecks.
//
// Every edit goes through `update`, which applies a function to the latest
// body (not the one this render closed over). A blur can commit a number
// and re-sort salary steps in the same event; both edits must compose.

import { AlertTriangle, ChevronRight, X } from "lucide-react"
import * as React from "react"

import { NumberField, Segmented, usdShort } from "@/components/fire/controls"
import { Button } from "@/components/ui/button"
import { grossAt, type JobWindow, jobEnd, jobWindows } from "@/lib/runway/jobs"
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

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** Enabled steps in month order. */
function enabledSteps(job: Job): SalaryStep[] {
  return job.salary
    .filter((s) => s.enabled)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
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

/** The first month of the job inside the horizon (or its start). */
function firstPaidMonth(job: Job, months: string[]): string {
  const first = months[0] ?? thisMonth()
  return job.start && job.start > first ? job.start : first
}

/** One clause of the collapsed summary. */
function jobClause(
  job: Job,
  windows: JobWindow[],
  months: string[],
  isFirst: boolean
): string {
  const eff = firstPaidMonth(job, months)
  const end =
    windows.filter((w) => w.jobId === job.id).at(-1)?.to ?? months.at(-1) ?? eff
  const later = enabledSteps(job).filter((s) => s.from > eff && s.from <= end)
  let t = `${job.employer || "Unnamed job"} ${usdShort(grossAt(job, eff))}`
  if (later[0]) t += ` → ${usdShort(later[0].gross)} ${monName(later[0].from)}`
  if (later.length > 1)
    t += ` +${later.length - 1} step${later.length > 2 ? "s" : ""}`
  if (!isFirst && job.start) t += ` from ${monLong(job.start)}`
  return t
}

function sectionSummary(
  jobs: Job[],
  windows: JobWindow[],
  months: string[]
): string {
  const paying = new Set(windows.map((w) => w.jobId).filter(Boolean))
  const on = jobs
    .filter((j) => j.enabled && paying.has(j.id))
    .sort((a, b) => ((a.start ?? "") < (b.start ?? "") ? -1 : 1))
  if (!on.length) return "No pay"
  const clauses = on.map((j, i) => jobClause(j, windows, months, i === 0))
  for (const w of windows) {
    if (w.jobId != null) continue
    clauses.push(
      `No pay ${monLong(w.from)}${w.to !== w.from ? ` to ${monLong(w.to)}` : ""}`
    )
  }
  return clauses.join(" · ")
}

function newJobId(taken: Set<string>): string {
  for (;;) {
    const id = `job-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
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

  const jumpTo = (id: string) => {
    setCardOpen(id, true)
    requestAnimationFrame(() => {
      const card = rootRef.current?.querySelector<HTMLElement>(
        `[data-job-card="${CSS.escape(id)}"]`
      )
      card?.scrollIntoView({
        block: "nearest",
        behavior: reducedMotion() ? "auto" : "smooth",
      })
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-job-header="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true })
    })
  }

  // Errors at "jobs" or "pay" themselves, not under a job or a pay field.
  const looseErrors = errorKeys
    .filter((k) => k === "jobs" || k === "pay")
    .map((k) => errors[k])

  return (
    <InputsSection
      title="Jobs and pay"
      hint="Who pays you and when. A job ends when you leave or when the next job starts."
      summary={sectionSummary(jobs, windows, months)}
      badge={fromPlan > 0 ? <RowTag>{fromPlan} from Plan</RowTag> : undefined}
      forceOpen={hasErrors}
    >
      <div ref={rootRef} className="flex min-w-0 flex-col gap-3 @md:col-span-2">
        {looseErrors.map((msg) => (
          <span
            key={msg}
            className="text-rose-600 text-xs dark:text-rose-400"
            data-field-error=""
          >
            {msg}
          </span>
        ))}
        {months.length ? (
          <JobTimeline
            jobs={jobs}
            windows={windows}
            months={months}
            onJump={jumpTo}
          />
        ) : null}

        {jobs.length === 0 && !rows.length ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3 text-muted-foreground text-xs">
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

// ----------------------------------------------------------------- timeline

function JobTimeline({
  jobs,
  windows,
  months,
  onJump,
}: {
  jobs: Job[]
  windows: JobWindow[]
  months: string[]
  onJump: (id: string) => void
}) {
  const n = months.length
  const idx = new Map(months.map((m, i) => [m, i]))
  const byId = new Map(jobs.map((j) => [j.id, j]))
  // Alternate shades by job, in order of first appearance.
  const shade = new Map<string, number>()
  for (const w of windows)
    if (w.jobId && !shade.has(w.jobId)) shade.set(w.jobId, shade.size)

  // Ticks: each job window's opening gross, then each step inside it.
  const ticks: { at: number; label: string }[] = []
  for (const w of windows) {
    const job = w.jobId ? byId.get(w.jobId) : null
    if (!job) continue
    const start = idx.get(w.from) ?? 0
    ticks.push({ at: start, label: usdShort(grossAt(job, w.from)).slice(1) })
    for (const s of enabledSteps(job)) {
      if (s.from > w.from && s.from <= w.to)
        ticks.push({
          at: idx.get(s.from) ?? start,
          label: usdShort(s.gross).slice(1),
        })
    }
  }
  ticks.sort((a, b) => a.at - b.at)
  // Labels closer than three months apart would overlap; keep the first.
  let lastLabel = -99
  const shownTicks = ticks.map((t) => {
    const show = t.at - lastLabel >= 3
    if (show) lastLabel = t.at
    return { ...t, show }
  })

  const axis: { at: number; label: string }[] = [
    { at: 0, label: shortMonth(months[0]) },
  ]
  months.forEach((m, i) => {
    if (m.endsWith("-01") && i >= 3 && i <= n - 4)
      axis.push({ at: i, label: m.slice(0, 4) })
  })
  if (n > 1) axis.push({ at: n - 1, label: shortMonth(months[n - 1]) })

  const left = (at: number) => `${(at / n) * 100}%`
  const edge = (at: number) =>
    at > n - 4 ? "-translate-x-full text-right" : ""

  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-4 text-[11px] text-muted-foreground">
        {axis.map((a) => (
          <span
            key={`${a.at}-${a.label}`}
            className={cn(
              "absolute top-0 whitespace-nowrap font-mono tabular-nums",
              a.at === n - 1 && "right-0",
              a.at !== n - 1 && edge(a.at)
            )}
            style={a.at === n - 1 ? undefined : { left: left(a.at) }}
          >
            {a.label}
          </span>
        ))}
      </div>
      <div
        role="group"
        aria-label="Who pays you, by month"
        className="grid h-6 gap-px"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {windows.map((w) => {
          const from = idx.get(w.from) ?? 0
          const span = (idx.get(w.to) ?? from) - from + 1
          const style = { gridColumn: `${from + 1} / span ${span}` }
          const range =
            w.from === w.to
              ? monLong(w.from)
              : `${monLong(w.from)} to ${monLong(w.to)}`
          const job = w.jobId ? byId.get(w.jobId) : null
          if (!job) {
            return (
              <div
                key={`gap-${w.from}`}
                style={{
                  ...style,
                  backgroundImage:
                    "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, currentColor 14%, transparent) 4px 6px)",
                }}
                className="flex min-w-0 items-center justify-center overflow-hidden bg-muted text-[11px] text-muted-foreground first:rounded-l-md last:rounded-r-md"
              >
                <span className="sr-only">No pay, {range}</span>
                {span >= 2 ? (
                  <span aria-hidden="true" className="truncate px-1">
                    No pay
                  </span>
                ) : null}
              </div>
            )
          }
          return (
            <button
              key={`${job.id}-${w.from}`}
              type="button"
              style={style}
              aria-label={`${job.employer || "Unnamed job"}, ${range}`}
              onClick={() => onJump(job.id)}
              className={cn(
                "relative flex min-w-0 items-center overflow-visible px-1.5 text-left text-[11px] text-foreground outline-none before:absolute before:inset-x-0 before:-inset-y-1 first:rounded-l-md last:rounded-r-md hover:bg-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:before:-inset-y-2.5",
                (shade.get(job.id) ?? 0) % 2 ? "bg-primary/30" : "bg-primary/15"
              )}
            >
              <span className="min-w-0 truncate">{job.employer}</span>
            </button>
          )
        })}
      </div>
      {shownTicks.length ? (
        <div
          className="relative h-4 text-[11px] text-muted-foreground"
          aria-hidden="true"
        >
          {shownTicks.map((t) => (
            <span
              key={`${t.at}-${t.label}`}
              className={cn(
                "absolute top-0 flex items-center gap-0.5 whitespace-nowrap font-mono tabular-nums",
                edge(t.at)
              )}
              style={{ left: left(t.at) }}
            >
              <span className="h-2 w-px bg-muted-foreground/60" />
              {t.show ? t.label : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** "Nov '26". */
function shortMonth(m: string | undefined): string {
  if (!m) return ""
  return `${monName(m)} ’${m.slice(2, 4)}`
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
      <span className="min-w-0 truncate text-muted-foreground line-through opacity-55">
        {job.employer}
      </span>
      <RowTag>Removed in scenario</RowTag>
      {readOnly ? null : (
        <button
          type="button"
          data-job-restore={job.id}
          onClick={onRestore}
          className="relative ml-auto text-muted-foreground text-xs outline-none before:absolute before:-inset-2 hover:text-foreground focus-visible:underline pointer-coarse:before:-inset-3"
        >
          Restore
        </button>
      )}
    </div>
  )
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
  const pays = job.enabled && windows.some((w) => w.jobId === job.id)
  const before = job.start == null || job.start < first
  const endM = job.enabled ? (end?.last ?? null) : job.leave
  const dates = before
    ? endM
      ? `before plan to ${monLong(endM)}`
      : "whole plan"
    : endM
      ? `${monLong(job.start)} to ${monLong(endM)}`
      : `from ${monLong(job.start)}`
  const gross = grossAt(job, firstPaidMonth(job, months))

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
          .sort((a, b) => ((a.start ?? "") < (b.start ?? "") ? -1 : 1))[0] ??
        null)

  let hint: React.ReactNode = null
  if (!job.enabled) hint = "Off: not in this plan"
  else if (!pays) hint = "Pays nothing inside the plan: a later job covers it."
  else if (end && !end.gap && end.next && job.leave !== end.last)
    hint = `Ends ${monLong(end.last)} when ${end.next.employer} starts`
  else if (end?.gap)
    hint = (
      <span className="inline-flex items-start gap-1 text-amber-700 dark:text-amber-400">
        <AlertTriangle
          size={12}
          aria-hidden="true"
          className="mt-px shrink-0"
        />
        {end.next?.start
          ? `Leaves ${monLong(end.last)}. No pay until ${end.next.employer} starts in ${monLong(end.next.start)}.`
          : `Leaves ${monLong(end.last)}. No pay after that.`}
      </span>
    )

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
  return (
    <div
      data-job-card={job.id}
      className="@container flex scroll-mt-14 flex-col rounded-lg ring-1 ring-foreground/10"
    >
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <div className="flex min-h-9 items-center gap-2 text-xs md:min-h-7">
          <HitToggle
            checked={job.enabled}
            onChange={(v) => setJob((j) => ({ ...j, enabled: v }))}
            label={`Include ${name}`}
          />
          <button
            type="button"
            data-job-header={job.id}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => onOpenChange(!open)}
            className="flex min-w-0 items-center gap-1 rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                open && "rotate-90"
              )}
            />
            <span className={cn("truncate", !job.enabled && "opacity-55")}>
              {job.employer || "Unnamed job"}
            </span>
          </button>
          {jobEdited ? (
            <EditedDot
              onReset={() =>
                savedJob && setJob(() => structuredClone(savedJob))
              }
            />
          ) : null}
          {tag ? <RowTag>{tag}</RowTag> : null}
          <span className="ml-auto hidden shrink-0 whitespace-nowrap text-muted-foreground @md:inline">
            {dates}
          </span>
          <span
            className={cn(
              "ml-auto shrink-0 font-mono tabular-nums @md:ml-0",
              !job.enabled && "opacity-55"
            )}
          >
            {usdShort(gross)}
          </span>
          {readOnly ? null : (
            <IconButton label={`Remove ${name}`} onClick={onRemove}>
              <X size={12} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <span className="pl-9 text-muted-foreground text-xs @md:hidden">
          {dates}
        </span>
        {hint ? (
          <span className="pl-9 text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </div>

      {open ? (
        <div
          id={bodyId}
          className={cn(
            "grid gap-x-4 gap-y-3 border-t px-3 pt-3 pb-3 @md:grid-cols-2",
            !job.enabled && "opacity-55"
          )}
        >
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
              <MonthField
                id={fid("start")}
                ariaLabel={`${name} start month`}
                value={job.start ?? ""}
                max={last}
                onChange={(start) => setJob((j) => ({ ...j, start }))}
              />
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

          <div className="flex min-w-0 flex-col gap-1.5 @md:col-span-2">
            <div className="flex items-center gap-1.5 text-xs">
              <span>Salary (gross)</span>
              <Markers {...m("salary", salaryText)} />
            </div>
            <SalarySteps
              steps={job.salary}
              jobStart={job.start}
              months={months}
              who={name}
              readOnly={readOnly}
              errors={errors}
              path={`${path}.salary`}
              onChange={(fn) => setJob((j) => ({ ...j, salary: fn(j.salary) }))}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5 @md:col-span-2">
            <div className="flex items-center gap-1.5 text-xs">
              <span>401k match</span>
              <Markers {...m("match", matchText)} />
            </div>
            <MatchEditor
              value={job.match}
              readOnly={readOnly}
              onChange={(match) => setJob((j) => ({ ...j, match }))}
            />
            {errUnder(errors, `${path}.match`) ? (
              <span className="text-rose-600 text-xs dark:text-rose-400">
                {errUnder(errors, `${path}.match`)}
              </span>
            ) : null}
          </div>

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

          {otherErrors.map(([k, msg]) => (
            <span
              key={k}
              className="text-rose-600 text-xs @md:col-span-2 dark:text-rose-400"
              data-field-error=""
            >
              {msg}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------- salary steps

function SalarySteps({
  steps,
  jobStart,
  months,
  who,
  readOnly,
  errors,
  path,
  onChange,
}: {
  steps: SalaryStep[]
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

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const k = lk.keys[i]
        const when = monLong(s.from)
        const err =
          errUnder(errors, `${path}[${i}]`) ??
          (dupAt.has(i) ? `Two steps start in ${when}.` : undefined)
        const only = steps.length <= 1
        return (
          <div
            key={k}
            data-step={k}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                sortSteps()
            }}
            className="flex flex-col gap-1"
          >
            <div
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 @md:grid-cols-[auto_8.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]",
                !s.enabled && "text-muted-foreground"
              )}
            >
              <HitToggle
                checked={s.enabled}
                onChange={(v) => set(i, { enabled: v })}
                label={`Include ${when} step`}
              />
              <Lock disabled={readOnly}>
                <MonthField
                  ariaLabel={`${who} salary step month`}
                  value={s.from}
                  onChange={(from) => set(i, { from })}
                />
              </Lock>
              <Lock
                disabled={readOnly}
                className="order-last col-span-3 grid grid-cols-2 gap-2 @md:contents"
              >
                <span data-step-gross="" className="contents">
                  <NumberField
                    ariaLabel={`Gross from ${when}`}
                    prefix="$"
                    suffix="/yr"
                    className={cn(FIELD, !s.enabled && "opacity-70")}
                    value={s.gross}
                    onChange={(v) => set(i, { gross: Math.max(0, v) })}
                  />
                </span>
                <input
                  aria-label={`Note for ${when} step`}
                  placeholder="Note"
                  value={s.note ?? ""}
                  autoComplete="off"
                  data-1p-ignore
                  onChange={(e) => set(i, { note: e.target.value || null })}
                  className={TEXT_INPUT}
                />
              </Lock>
              {readOnly ? (
                <span />
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
                  className="ml-1 @md:order-last"
                  onClick={() => remove(i)}
                >
                  <X size={12} aria-hidden="true" />
                </IconButton>
              )}
            </div>
            {err ? (
              <span
                className="text-rose-600 text-xs dark:text-rose-400"
                data-field-error=""
              >
                {err}
              </span>
            ) : null}
          </div>
        )
      })}
      {gapWarning ? (
        <span className="inline-flex items-start gap-1 text-amber-700 text-xs dark:text-amber-400">
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

function MatchEditor({
  value,
  readOnly,
  onChange,
}: {
  value: Match
  readOnly: boolean
  onChange: (m: Match) => void
}) {
  const uid = React.useId()
  // Each type's last values, so flipping types and back loses nothing.
  const stash = React.useRef<Partial<Record<Match["type"], Match>>>({})
  stash.current[value.type] = value
  const tierCount = value.type === "tiered" ? value.tiers.length : 0
  const lk = useLocalKeys(tierCount)

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
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              >
                <NumberField
                  ariaLabel={`Tier ${i + 1} match rate`}
                  suffix="%"
                  className={cn(FIELD, "w-20 md:w-20")}
                  value={pctIn(t.rate)}
                  onChange={(v) => setTier({ rate: Math.max(0, v) / 100 })}
                />
                <span className="text-muted-foreground">
                  match on pay up to
                </span>
                <NumberField
                  ariaLabel={`Tier ${i + 1} applies up to, percent of pay`}
                  suffix="%"
                  className={cn(FIELD, "w-20 md:w-20")}
                  value={pctIn(t.upToPct)}
                  onChange={(v) => setTier({ upToPct: Math.max(0, v) / 100 })}
                />
                {readOnly ? null : (
                  <IconButton
                    label={`Remove tier ${i + 1}`}
                    disabled={value.tiers.length <= 1}
                    title={
                      value.tiers.length <= 1
                        ? "A tiered match needs at least one tier"
                        : undefined
                    }
                    className="ml-1"
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
      <span className="text-muted-foreground text-xs">
        {value.type === "none" ? "No employer match." : matchText(value)}
      </span>
    </Lock>
  )
}

// ------------------------------------------------------------ pay overrides

function DetailsRow({
  title,
  summary,
  open,
  onOpenChange,
  className,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onOpenChange: (v: boolean) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <details
      open={open}
      onToggle={(e) =>
        onOpenChange((e.currentTarget as HTMLDetailsElement).open)
      }
      className={cn("group min-w-0", className)}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-baseline gap-2 rounded-sm text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-7 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="shrink-0">{title}</span>
        <span className="min-w-0 text-muted-foreground">{summary}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-4 border-l pl-3">{children}</div>
    </details>
  )
}

/** One override item: the person default with [Override], or the editor
 * with "Use person default". */
function OverrideItem({
  label,
  overridden,
  defaultText,
  markers,
  readOnly,
  onOverride,
  onUseDefault,
  overrideLabel = "Override",
  defaultLabel = "Use person default",
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
  const textBtn =
    "relative shrink-0 text-muted-foreground text-xs underline-offset-2 outline-none before:absolute before:-inset-2 hover:text-foreground focus-visible:underline pointer-coarse:before:-inset-3"
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
            className={cn(textBtn, "ml-auto")}
            onClick={onUseDefault}
          >
            {defaultLabel}
          </button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto h-8 md:h-6"
            onClick={onOverride}
          >
            {overrideLabel}
          </Button>
        )}
      </div>
      {overridden ? children : null}
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
    job.schedule ? "schedule" : null,
    job.deductions ? "deductions" : null,
    job.withholding ? "withholding" : null,
  ].filter(Boolean)
  const summary = [
    overrides.length
      ? `Overrides: ${overrides.join(", ")}`
      : "Uses person defaults",
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
    <DetailsRow
      title="Pay overrides"
      summary={summary}
      open={open}
      onOpenChange={setOpen}
      className="@md:col-span-2"
    >
      <OverrideItem
        label="Pay schedule"
        overridden={job.schedule != null}
        defaultText={`person default (${scheduleText(pay.schedule)})`}
        markers={m("schedule", (v: PaySchedule | null) =>
          v ? scheduleText(v) : "person default"
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
        defaultText={`person default (${deductionsText(pay.deductions)})`}
        markers={m("deductions", (v: Deduction[] | null) =>
          v ? deductionsText(v) : "person default"
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
        defaultText={`person default (${withholdingText(pay.withholding)})`}
        markers={m("withholding", (v: Withholding | null) =>
          v ? withholdingText(v) : "person default"
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
        defaultText="none"
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
    </DetailsRow>
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

  const sched = scheduleText(pay.schedule)
  const summary = `${sched[0].toUpperCase()}${sched.slice(1)} · ${deductionsText(
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
    <DetailsRow
      title="Pay defaults"
      summary={summary}
      open={open}
      onOpenChange={setOpen}
    >
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
                className="h-8 md:h-6"
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
              <span className="text-rose-600 dark:text-rose-400">
                {errors["pay.schedule"]}
              </span>
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
        <span
          key={k}
          className="text-rose-600 text-xs dark:text-rose-400"
          data-field-error=""
        >
          {msg}
        </span>
      ))}
    </DetailsRow>
  )
}
