// Who pays when: job windows and salary steps. Shared by the engine and the
// jobs editor's timeline so both read the same answer.
//
// A job pays from `start` (null: from before the horizon) through `leave`,
// or until the next enabled job starts, whichever is first. When two enabled
// jobs overlap, the one that started later wins. A month with no job pays
// nothing.

import type { Job, Pay, ResolvedJob } from "./types"

/** The job paying in month `m` (YYYY-MM), or null. */
export function activeJobAt<J extends Job>(jobs: J[], m: string): J | null {
  let best: J | null = null
  for (const j of jobs) {
    if (!j.enabled) continue
    if (j.start != null && j.start > m) continue
    if (j.leave != null && m > j.leave) continue
    // Later start wins; a null start is the earliest. Ties: later in the list.
    if (best == null || (j.start ?? "") >= (best.start ?? "")) best = j
  }
  return best
}

/** Annual gross in month `m`: the latest enabled step on or before it, else 0. */
export function grossAt(job: Job, m: string): number {
  let gross = 0
  for (const s of job.salary) if (s.enabled && s.from <= m) gross = s.gross
  return gross
}

/** The job with the person's pay settings filled in, or null when it has no
 * pay schedule at all. */
export function resolveJob(job: Job, pay: Pay): ResolvedJob | null {
  const schedule = job.schedule ?? pay.schedule
  if (!schedule) return null
  return {
    ...job,
    schedule,
    deductions: job.deductions ?? pay.deductions,
    withholding: job.withholding ?? pay.withholding,
  }
}

export interface JobWindow {
  /** null: a gap with no pay. */
  jobId: string | null
  from: string
  to: string
}

/** Consecutive runs of the same paying job over `months`. */
export function jobWindows(jobs: Job[], months: string[]): JobWindow[] {
  const out: JobWindow[] = []
  for (const m of months) {
    const id = activeJobAt(jobs, m)?.id ?? null
    const last = out.at(-1)
    if (last && last.jobId === id) last.to = m
    else out.push({ jobId: id, from: m, to: m })
  }
  return out
}

/** When an enabled job stops paying inside `months`, and why. */
export function jobEnd(
  jobs: Job[],
  job: Job,
  months: string[]
): { last: string; next: Job | null; gap: boolean } | null {
  const windows = jobWindows(jobs, months)
  let i = -1
  windows.forEach((w, k) => {
    if (w.jobId === job.id) i = k
  })
  if (i < 0 || i === windows.length - 1) return null
  const after = windows[i + 1]
  const nextWindow = windows.slice(i + 1).find((w) => w.jobId != null)
  return {
    last: windows[i].to,
    next: nextWindow
      ? (jobs.find((j) => j.id === nextWindow.jobId) ?? null)
      : null,
    gap: after.jobId == null,
  }
}
