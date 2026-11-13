import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyPatch,
  countChanges,
  deepEqual,
  diffPatch,
  getPath,
  listKey,
  setPath,
} from "./patch"

const roundTrip = (prev: unknown, next: unknown) => {
  const patch = diffPatch(next, prev)
  assert.deepEqual(applyPatch(prev, patch), next)
  return patch
}

const base = {
  label: "Plan",
  spendingMonthly: 4_000,
  returns: { equity: 0.07, reserve: 0.04 },
  jobs: [
    { id: "a", employer: "A", salary: [{ from: "2026-01", gross: 100 }] },
    { id: "b", employer: "B", salary: [{ from: "2027-01", gross: 200 }] },
  ],
  hsaCoverage: [{ from: "2026-01", tier: "self" }],
  tags: ["x", "y"],
}

test("objects merge key by key; untouched keys stay", () => {
  const out = applyPatch(base, { returns: { equity: 0.05 } })
  assert.deepEqual(out.returns, { equity: 0.05, reserve: 0.04 })
  assert.equal(out.label, "Plan")
  // Neither input is modified.
  assert.equal(base.returns.equity, 0.07)
})

test("keyed lists merge by id; new ids append", () => {
  const out = applyPatch(base, {
    jobs: [
      { id: "b", employer: "B2" },
      { id: "c", employer: "C", salary: [] },
    ],
  })
  assert.deepEqual(
    out.jobs.map((j) => [j.id, j.employer]),
    [
      ["a", "A"],
      ["b", "B2"],
      ["c", "C"],
    ]
  )
  // The merged item keeps the fields the patch did not set.
  assert.deepEqual(out.jobs[1].salary, [{ from: "2027-01", gross: 200 }])
})

test("lists without ids merge by from", () => {
  const out = applyPatch(base, {
    hsaCoverage: [{ from: "2027-04", tier: "none" }],
  })
  assert.deepEqual(out.hsaCoverage, [
    { from: "2026-01", tier: "self" },
    { from: "2027-04", tier: "none" },
  ])
})

test("unkeyed lists and scalars replace", () => {
  const out = applyPatch(base, { tags: ["z"], spendingMonthly: 5_000 })
  assert.deepEqual(out.tags, ["z"])
  assert.equal(out.spendingMonthly, 5_000)
  assert.equal(listKey(["x"]), null)
  // Duplicate keys make a list unkeyed.
  assert.equal(listKey([{ id: "a" }, { id: "a" }]), null)
  assert.equal(listKey([{ id: "a", from: "2026-01" }]), "id")
  assert.equal(listKey([{ from: "2026-01" }]), "from")
})

test("a removal marker drops the item; a missing one is a no-op", () => {
  const out = applyPatch(base, {
    jobs: [
      { id: "a", remove: true },
      { id: "zz", remove: true },
    ],
  })
  assert.deepEqual(
    out.jobs.map((j) => j.id),
    ["b"]
  )
  // A new key whose list holds markers keeps only the real items, unmarked.
  const added = applyPatch(
    {},
    {
      extra: [
        { id: "p", remove: false, v: 1 },
        { id: "q", remove: true },
      ],
    }
  )
  assert.deepEqual(added, { extra: [{ id: "p", v: 1 }] })
})

test("null in a patch sets the key to null", () => {
  const out = applyPatch(base, { returns: null })
  assert.equal(out.returns, null)
})

test("diff then apply round-trips on keyed and unkeyed changes", () => {
  const next = {
    ...base,
    spendingMonthly: 4_500,
    returns: { ...base.returns, equity: 0.06 },
    jobs: [
      base.jobs[0],
      {
        ...base.jobs[1],
        salary: [...base.jobs[1].salary, { from: "2028-01", gross: 210 }],
      },
      { id: "c", employer: "C", salary: [] },
    ],
    hsaCoverage: [...base.hsaCoverage, { from: "2027-04", tier: "none" }],
    tags: ["y"],
  }
  const patch = roundTrip(base, next) as Record<string, unknown>
  // Only the changed job and the new one are in the patch, by id.
  assert.deepEqual(patch.jobs, [
    { salary: [{ from: "2028-01", gross: 210 }], id: "b" },
    { id: "c", employer: "C", salary: [] },
  ])
  assert.deepEqual(patch.tags, ["y"])
  assert.equal("label" in patch, false)
})

test("a removed list item diffs to a removal marker", () => {
  const next = { ...base, jobs: [base.jobs[1]] }
  const patch = roundTrip(base, next) as Record<string, unknown>
  assert.deepEqual(patch.jobs, [{ id: "a", remove: true }])
})

test("a removed key diffs to null, and applying it sets null", () => {
  // As in runway_patch.py: null marks the removal, and applying it keeps the
  // key with a null value (plan bodies always carry every key, so a removed
  // value is a null one).
  const { tags: _tags, ...next } = base
  const patch = diffPatch(next, base) as Record<string, unknown>
  assert.deepEqual(patch, { tags: null })
  const out = applyPatch(base, patch) as Record<string, unknown>
  assert.equal(out.tags, null)
  assert.deepEqual({ ...out, tags: undefined }, { ...next, tags: undefined })
  // A key that is null on both sides is no change.
  assert.deepEqual(diffPatch({ a: null }, { a: null }), {})
})

test("diff of a reordered keyed list is empty", () => {
  const next = { ...base, jobs: [base.jobs[1], base.jobs[0]] }
  assert.deepEqual(diffPatch(next, base), {})
  assert.deepEqual(diffPatch(base, base), {})
})

test("countChanges counts leaves; a list item added or removed counts once", () => {
  assert.equal(countChanges({}), 0)
  assert.equal(countChanges({ spendingMonthly: 1 }), 1)
  assert.equal(countChanges({ returns: { equity: 1, reserve: 2 } }), 2)
  assert.equal(countChanges({ jobs: [{ id: "a", remove: true }] }), 1)
  // A keyed item counts its own leaves (the key included).
  assert.equal(countChanges({ jobs: [{ id: "b", employer: "B2" }] }), 2)
  // An unkeyed list is one change.
  assert.equal(countChanges({ tags: ["a", "b", "c"] }), 1)
  assert.equal(countChanges({ returns: null }), 1)
})

test("deepEqual ignores undefined keys", () => {
  assert.ok(deepEqual({ a: 1, b: undefined }, { a: 1 }))
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }))
  assert.ok(!deepEqual([1, 2], [2, 1]))
})

test("getPath and setPath on dotted paths", () => {
  assert.equal(getPath(base, "returns.equity"), 0.07)
  assert.equal(getPath(base, "returns.nope.deeper"), undefined)
  const out = setPath(base, "limits.2028.k401", 25_000)
  assert.deepEqual(getPath(out, "limits.2028"), { k401: 25_000 })
  assert.equal("limits" in base, false)
})
