// Unsaved /runway edits, per person, plus the shared defaults. Pure; the
// React side lives in hooks/use-runway-drafts.ts.
//
// A person's draft holds the edited plan, the scenarios as patches over that
// plan (so plan edits flow into every scenario that does not change the same
// setting), and the shared settings the person overrides. Plan bodies carry
// the *merged* value of every shared setting; editing one on the plan makes
// it a per-person override, and editing the shared defaults updates every
// person that does not override it (both the edited and the saved copy, so a
// shared edit never makes a person look dirty).
//
// Erasable TypeScript only so `node --test` can run it from source.

import {
  applyPatch,
  countChangesOver,
  deepEqual,
  diffPatch,
  getPath,
  setPath,
} from "./patch"
import type {
  PersonRecord,
  PlanBody,
  ScenarioDef,
  SharedSettings,
} from "./types"
import { PLAN_ID } from "./types"

export interface PersonDraft {
  saved: PersonRecord
  plan: PlanBody
  scenarios: ScenarioDef[]
  overrides: string[]
}

export interface SharedDraft {
  saved: SharedSettings
  edited: SharedSettings
}

export function draftFrom(record: PersonRecord): PersonDraft {
  return {
    saved: record,
    plan: record.plan,
    scenarios: record.scenarios,
    overrides: record.overrides,
  }
}

/** A scenario's body in the draft (the plan for PLAN_ID). */
export function bodyIn(d: PersonDraft, scenarioId: string): PlanBody {
  const s = d.scenarios.find((x) => x.id === scenarioId)
  return s ? applyPatch(d.plan, s.patch) : d.plan
}

/** The saved body of the same target, or null for a scenario not saved yet. */
export function savedBodyIn(
  d: PersonDraft,
  scenarioId: string
): PlanBody | null {
  if (scenarioId === PLAN_ID) return d.saved.plan
  const s = d.saved.scenarios.find((x) => x.id === scenarioId)
  return s ? applyPatch(d.saved.plan, s.patch) : null
}

// ---------- shared settings ----------

/** Every shared leaf path present in either settings object. */
export function sharedPaths(...sources: Pick<PlanBody, "limits">[]): string[] {
  const out = [
    "returns.equity",
    "returns.reserve",
    "returns.ef",
    "returns.gold",
    "playCap",
    "spreadThrough",
  ]
  const limits = new Set<string>()
  for (const src of sources)
    for (const [y, row] of Object.entries(src.limits ?? {}))
      for (const k of Object.keys(row ?? {})) limits.add(`limits.${y}.${k}`)
  return [...out, ...[...limits].sort()]
}

/** `body` with every shared leaf the person does not override set from
 * `shared`. A limit the shared defaults no longer set is dropped. */
export function withShared(
  body: PlanBody,
  shared: SharedSettings,
  overrides: string[]
): PlanBody {
  const own = new Set(overrides)
  let out = body
  for (const path of sharedPaths(body, shared)) {
    if (own.has(path)) continue
    const v = getPath(shared, path)
    if (path.startsWith("limits.")) {
      const [, y, k] = path.split(".")
      const row = { ...(out.limits[y] ?? {}) } as Record<string, number>
      if (v === undefined) delete row[k]
      else row[k] = v as number
      const limits = { ...out.limits }
      if (Object.keys(row).length) limits[y] = row
      else delete limits[y]
      out = { ...out, limits }
    } else if (v !== undefined) out = setPath(out, path, v)
  }
  return out
}

/** Apply edited shared settings to a person draft (edited and saved copies). */
export function applySharedTo(
  d: PersonDraft,
  shared: SharedSettings
): PersonDraft {
  return {
    ...d,
    plan: withShared(d.plan, shared, d.overrides),
    saved: {
      ...d.saved,
      plan: withShared(d.saved.plan, shared, d.saved.overrides),
    },
  }
}

// ---------- edits ----------

/** Replace one target's body. On the plan, a changed shared leaf becomes a
 * per-person override. */
export function setBody(
  d: PersonDraft,
  scenarioId: string,
  next: PlanBody
): PersonDraft {
  if (scenarioId !== PLAN_ID) {
    return {
      ...d,
      scenarios: d.scenarios.map((s) =>
        s.id === scenarioId
          ? { ...s, patch: diffPatch(next, d.plan) as Record<string, unknown> }
          : s
      ),
    }
  }
  const overrides = new Set(d.overrides)
  for (const path of sharedPaths(next, d.plan))
    if (!deepEqual(getPath(next, path), getPath(d.plan, path)))
      overrides.add(path)
  return { ...d, plan: next, overrides: [...overrides] }
}

/** Drop a per-person override: the plan follows the shared value again. */
export function resetToShared(
  d: PersonDraft,
  path: string,
  shared: SharedSettings
): PersonDraft {
  const overrides = d.overrides.filter((p) => p !== path)
  return { ...d, overrides, plan: withShared(d.plan, shared, overrides) }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "scenario"

/** A new scenario, empty (from the plan) or copying another's patch. */
export function addScenario(
  d: PersonDraft,
  label: string,
  fromId: string = PLAN_ID
): { draft: PersonDraft; id: string } {
  const taken = new Set([
    PLAN_ID,
    ...d.scenarios.map((s) => s.id),
    ...d.saved.scenarios.map((s) => s.id),
  ])
  const base = slug(label)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  const src = d.scenarios.find((s) => s.id === fromId)
  const patch = src
    ? (JSON.parse(JSON.stringify(src.patch)) as Record<string, unknown>)
    : {}
  return {
    draft: {
      ...d,
      scenarios: [...d.scenarios, { id, label: label.trim(), patch }],
    },
    id,
  }
}

export function renameScenario(
  d: PersonDraft,
  id: string,
  label: string
): PersonDraft {
  return {
    ...d,
    scenarios: d.scenarios.map((s) =>
      s.id === id ? { ...s, label: label.trim() } : s
    ),
  }
}

export function deleteScenario(d: PersonDraft, id: string): PersonDraft {
  return { ...d, scenarios: d.scenarios.filter((s) => s.id !== id) }
}

/** Why a scenario name is not acceptable, or null. */
export function scenarioNameError(
  d: PersonDraft,
  label: string,
  personLabel: string,
  selfId?: string
): string | null {
  const name = label.trim()
  if (!name) return "Give the scenario a name."
  if (name.toLowerCase() === PLAN_ID)
    return "Plan is the base. Pick another name."
  if (
    d.scenarios.some(
      (s) =>
        s.id !== selfId && s.label.trim().toLowerCase() === name.toLowerCase()
    )
  )
    return `${personLabel} already has a scenario called "${name}".`
  return null
}

// ---------- dirtiness ----------

/** What a save of this draft would change, by target. */
export function draftChanges(d: PersonDraft): {
  plan: number
  scenarios: { id: string; label: string; n: number }[]
  overrides: number
  total: number
} {
  const plan = countIf(d.saved.plan, diffPatch(d.plan, d.saved.plan))
  const scenarios: { id: string; label: string; n: number }[] = []
  for (const s of d.scenarios) {
    const was = d.saved.scenarios.find((x) => x.id === s.id)
    if (!was) {
      scenarios.push({ id: s.id, label: s.label, n: 1 })
      continue
    }
    // Compare what each scenario changes from its plan, so a plan edit that
    // scenarios follow is not counted again for each of them.
    const now = diffPatch(applyPatch(d.plan, s.patch), d.plan)
    const then = diffPatch(applyPatch(d.saved.plan, was.patch), d.saved.plan)
    const n =
      (deepEqual(now, then)
        ? 0
        : Math.max(1, countIf(then, diffPatch(now, then)))) +
      (was.label === s.label ? 0 : 1)
    if (n) scenarios.push({ id: s.id, label: s.label, n })
  }
  for (const was of d.saved.scenarios)
    if (!d.scenarios.some((s) => s.id === was.id))
      scenarios.push({ id: was.id, label: was.label, n: 1 })
  const a = new Set(d.overrides)
  const b = new Set(d.saved.overrides)
  const overrides =
    [...a].filter((x) => !b.has(x)).length +
    [...b].filter((x) => !a.has(x)).length
  // An override dropped with no value change still needs a save.
  const total =
    plan + scenarios.reduce((n, s) => n + s.n, 0) + (plan === 0 ? overrides : 0)
  return { plan, scenarios, overrides, total }
}

function countIf(base: unknown, patch: unknown): number {
  return patch && typeof patch === "object" && Object.keys(patch).length
    ? countChangesOver(base, patch)
    : 0
}

export const isDirty = (d: PersonDraft) => draftChanges(d).total > 0
export const isSharedDirty = (s: SharedDraft) => !deepEqual(s.edited, s.saved)

// ---------- save ----------

export interface SaveBody {
  version: string
  person?: {
    id: string
    plan: PlanBody
    overrides: string[]
    scenarios: { id: string; label: string; person: PlanBody }[]
  }
  shared?: SharedSettings
}

export function saveBody(
  version: string,
  d: PersonDraft | null,
  shared: SharedDraft | null
): SaveBody {
  const out: SaveBody = { version }
  if (d && isDirty(d))
    out.person = {
      id: d.saved.id,
      plan: d.plan,
      overrides: d.overrides,
      scenarios: d.scenarios.map((s) => ({
        id: s.id,
        label: s.label,
        person: applyPatch(d.plan, s.patch),
      })),
    }
  if (shared && isSharedDirty(shared)) out.shared = shared.edited
  return out
}

/** Server issue path -> (scenario id, body-relative path). People paths
 * look like `people[0].jobs[1].leave` or
 * `people[0].scenarios[2].patch.jobs[0].match.type`. */
export function issueTarget(
  path: string,
  scenarios: ScenarioDef[]
): { scenarioId: string; path: string } | null {
  const m = /^people\[\d+\]\.(?:scenarios\[(\d+)\]\.patch\.?)?(.*)$/.exec(path)
  if (!m) return null
  const scenarioId =
    m[1] != null ? (scenarios[Number(m[1])]?.id ?? null) : PLAN_ID
  return scenarioId ? { scenarioId, path: m[2] } : null
}
