import assert from "node:assert/strict"
import { test } from "node:test"

import type { CCCard, CcStatement, GridEntry } from "./schemas"
import {
  type CcOverrideTarget,
  defaultPayTotal,
  entryStatementKind,
  isActiveTarget,
  isCcTaggedPlan,
  isDialogPlan,
  normalizeEstimate,
  overrideKey,
  planMatchesTarget,
  resolveTarget,
  statementLabel,
  targetPaymentDate,
} from "./statements"

// Invented card and amounts only.
const CARD = "Liabilities:Credit:DemoCard"

function entry(patch: Partial<GridEntry>): GridEntry {
  return {
    id: "e1",
    kind: "plan",
    amount: "-100.00",
    description: "DemoCard",
    ccCardRef: CARD,
    ...patch,
  } as GridEntry
}

function closedStatement(patch: Partial<CcStatement> = {}): CcStatement {
  return {
    kind: "closed",
    account: CARD,
    id: "2030-05-20",
    statementBalance: "1234.56",
    dueDate: "2030-06-15",
    minimumPayment: "40.00",
    source: "fetch",
    capturedAt: "2030-05-21T13:00:00+00:00",
    effectiveDueDate: "2030-06-15",
    ...patch,
  }
}

function card(patch: Partial<CCCard> = {}): CCCard {
  return {
    accountPath: CARD,
    displayName: "DemoCard",
    isConfigured: true,
    hasMonthlyInputs: true,
    ...patch,
  } as CCCard
}

const CLOSED: CcOverrideTarget = {
  mode: "statement",
  statementId: "2030-05-20",
  kind: "closed",
}
const EXPECTED: CcOverrideTarget = {
  mode: "statement",
  statementId: "2030-06-20",
  kind: "expected",
}
const LEGACY: CcOverrideTarget = { mode: "legacy", cycleMonth: "2030-06" }

function statementCard(patch: Partial<CCCard> = {}): CCCard {
  const active = closedStatement()
  return card({
    hasStatements: true,
    activeStatement: active,
    statements: [active, closedStatement({ id: "2030-04-20" })],
    expectedStatement: {
      kind: "expected",
      account: CARD,
      id: "2030-06-20",
      dueDate: "2030-07-15",
      estimatedBalance: null,
      afterId: "2030-05-20",
      createdAt: "2030-06-01T12:00:00+00:00",
      updatedAt: "2030-06-01T12:00:00+00:00",
    },
    ...patch,
  })
}

test("resolveTarget: closed entry targets its statement", () => {
  const e = entry({
    kind: "cc-locked",
    ccStatementId: "2030-05-20",
    ccStatementKind: "closed",
    ccCycleMonth: "2030-06",
  })
  assert.deepEqual(resolveTarget(e, card()), { target: CLOSED })
})

test("resolveTarget: expected entry with an id targets the expected statement", () => {
  const e = entry({
    kind: "cc-forecast",
    ccStatementId: "2030-06-20",
    ccStatementKind: "expected",
  })
  assert.deepEqual(resolveTarget(e, card()), { target: EXPECTED })
})

test("resolveTarget: forecast without an id needs an expected statement", () => {
  const e = entry({
    kind: "cc-forecast",
    ccStatementId: null,
    ccStatementKind: "expected",
    ccCycleMonth: "2030-07",
  })
  assert.deepEqual(resolveTarget(e, card()), { needsExpected: true })
})

test("resolveTarget: legacy entry targets its cycle month", () => {
  const e = entry({ ccStatementKind: "legacy", ccCycleMonth: "2030-06" })
  assert.deepEqual(resolveTarget(e, card()), { target: LEGACY })
})

test("resolveTarget: orphan, untagged and card-less entries give null", () => {
  assert.equal(
    resolveTarget(
      entry({ ccStatementKind: "orphan", ccStatementId: "2030-01-20" })
    ),
    null
  )
  assert.equal(resolveTarget(entry({})), null)
  assert.equal(
    resolveTarget(entry({ ccCardRef: null, ccCycleMonth: "2030-06" })),
    null
  )
  // A closed kind with no id cannot be targeted.
  assert.equal(resolveTarget(entry({ ccStatementKind: "closed" })), null)
})

test("resolveTarget: missing ccStatementKind falls back to legacy", () => {
  const e = entry({ kind: "cc-locked", ccCycleMonth: "2030-06" })
  assert.equal(entryStatementKind(e), "legacy")
  assert.deepEqual(resolveTarget(e, card()), { target: LEGACY })
  assert.equal(entryStatementKind(entry({})), null)
})

test("isCcTaggedPlan: closed, expected and legacy plans are tagged; orphans are not", () => {
  assert.equal(
    isCcTaggedPlan(
      entry({ ccStatementKind: "closed", ccStatementId: "2030-05-20" })
    ),
    true
  )
  assert.equal(
    isCcTaggedPlan(
      entry({ ccStatementKind: "expected", ccStatementId: "2030-06-20" })
    ),
    true
  )
  assert.equal(isCcTaggedPlan(entry({ ccCycleMonth: "2030-06" })), true)
  assert.equal(
    isCcTaggedPlan(
      entry({ ccStatementKind: "orphan", ccStatementId: "2030-01-20" })
    ),
    false
  )
  assert.equal(isCcTaggedPlan(entry({})), false)
  assert.equal(isCcTaggedPlan(entry({ ccCardRef: null })), false)
  // Projection rows are not plans.
  assert.equal(
    isCcTaggedPlan(entry({ kind: "cc-locked", ccCycleMonth: "2030-06" })),
    false
  )
})

test("planMatchesTarget: statement target matches by id", () => {
  const e = entry({ ccStatementId: "2030-05-20", ccStatementKind: "closed" })
  assert.equal(planMatchesTarget(e, CARD, CLOSED), true)
  assert.equal(planMatchesTarget(e, CARD, EXPECTED), false)
  assert.equal(planMatchesTarget(e, "Liabilities:Credit:Other", CLOSED), false)
  assert.equal(
    planMatchesTarget(entry({ ...e, kind: "cc-locked" }), CARD, CLOSED),
    false
  )
  // A legacy row the server mapped to the statement carries the resolved id.
  const mapped = entry({
    ccCycleMonth: "2030-06",
    ccStatementId: "2030-05-20",
    ccStatementKind: "closed",
  })
  assert.equal(planMatchesTarget(mapped, CARD, CLOSED), true)
})

test("planMatchesTarget: legacy target matches by month, not when a statement id is set", () => {
  const legacy = entry({ ccCycleMonth: "2030-06", ccStatementKind: "legacy" })
  assert.equal(planMatchesTarget(legacy, CARD, LEGACY), true)
  assert.equal(
    planMatchesTarget(legacy, CARD, { mode: "legacy", cycleMonth: "2030-07" }),
    false
  )
  const mapped = entry({ ccCycleMonth: "2030-06", ccStatementId: "2030-05-20" })
  assert.equal(planMatchesTarget(mapped, CARD, LEGACY), false)
})

test("defaultPayTotal: closed uses lockedAmount, then remaining, then the balance", () => {
  assert.equal(
    defaultPayTotal(
      statementCard({ lockedAmount: "900.00", remaining: "1000.00" }),
      CLOSED
    ),
    900
  )
  assert.equal(
    defaultPayTotal(statementCard({ remaining: "1000.00" }), CLOSED),
    1000
  )
  assert.equal(defaultPayTotal(statementCard(), CLOSED), 1234.56)
  // overrideTotal is ignored here.
  assert.equal(
    defaultPayTotal(
      statementCard({ lockedAmount: "900.00", overrideTotal: "5.00" }),
      CLOSED
    ),
    900
  )
})

test("defaultPayTotal: minimum-only card gets the minimum", () => {
  const c = statementCard({
    minimumPaymentOnly: true,
    lockedAmount: "40.00",
    lockedSource: "minimum",
    remaining: "1234.56",
  })
  assert.equal(defaultPayTotal(c, CLOSED), 40)
})

test("defaultPayTotal: a closed statement that is not active uses its own balance", () => {
  const c = statementCard({ activeStatement: null, lockedAmount: null })
  assert.equal(defaultPayTotal(c, CLOSED), 1234.56)
  const credit = statementCard({
    activeStatement: null,
    statements: [closedStatement({ statementBalance: "-25.10" })],
  })
  assert.equal(defaultPayTotal(credit, CLOSED), 0)
})

test("defaultPayTotal: expected uses estimatedBalance, then computedForecast, then 0", () => {
  const withEstimate = statementCard({ computedForecast: "300.00" })
  if (withEstimate.expectedStatement) {
    withEstimate.expectedStatement = {
      ...withEstimate.expectedStatement,
      estimatedBalance: "850.00",
    }
  }
  assert.equal(defaultPayTotal(withEstimate, EXPECTED), 850)
  assert.equal(
    defaultPayTotal(statementCard({ computedForecast: "300.00" }), EXPECTED),
    300
  )
  assert.equal(defaultPayTotal(statementCard(), EXPECTED), 0)
})

test("defaultPayTotal: legacy uses remaining only for the active cycle", () => {
  const c = card({
    statementBalance: "1492.11",
    remaining: "502.10",
    cycleMonth: "2030-06",
  })
  assert.equal(defaultPayTotal(c, LEGACY), 502.1)
  assert.equal(
    defaultPayTotal(c, { mode: "legacy", cycleMonth: "2030-07" }),
    1492.11
  )
  assert.equal(defaultPayTotal(card(), LEGACY), 0)
})

test("statementLabel uses the closing month", () => {
  assert.equal(statementLabel(CLOSED), "May 2030 statement")
  assert.equal(statementLabel(EXPECTED), "June 2030 statement")
  assert.equal(statementLabel(LEGACY), "June 2030")
})

test("targetPaymentDate: closed uses that statement's effective due date", () => {
  assert.equal(
    targetPaymentDate(statementCard(), CLOSED, "2030-06-01"),
    "2030-06-15"
  )
  // An older statement is found in card.statements.
  const older = statementCard({
    statements: [
      closedStatement(),
      closedStatement({ id: "2030-04-20", effectiveDueDate: "2030-05-14" }),
    ],
  })
  assert.equal(
    targetPaymentDate(
      older,
      { mode: "statement", statementId: "2030-04-20", kind: "closed" },
      "2030-06-01"
    ),
    "2030-05-14"
  )
  // Unknown statement: the row date.
  assert.equal(
    targetPaymentDate(
      card(),
      { mode: "statement", statementId: "2030-01-20", kind: "closed" },
      "2030-06-01"
    ),
    "2030-06-01"
  )
})

test("targetPaymentDate: expected uses the predicted due date, else the row date", () => {
  assert.equal(
    targetPaymentDate(statementCard(), EXPECTED, "2030-07-01"),
    "2030-07-15"
  )
  assert.equal(
    targetPaymentDate(
      statementCard({ expectedStatement: null }),
      EXPECTED,
      "2030-07-01"
    ),
    "2030-07-01"
  )
})

test("targetPaymentDate: legacy clamps to the month and honors -1", () => {
  assert.equal(
    targetPaymentDate(card({ paymentDueDay: 15 }), LEGACY, "2030-06-01"),
    "2030-06-15"
  )
  assert.equal(
    targetPaymentDate(card({ paymentDueDay: 31 }), LEGACY, "2030-06-01"),
    "2030-06-30"
  )
  assert.equal(
    targetPaymentDate(
      card({ paymentDueDay: -1 }),
      { mode: "legacy", cycleMonth: "2030-02" },
      "2030-02-01"
    ),
    "2030-02-28"
  )
  assert.equal(targetPaymentDate(card(), LEGACY, "2030-06-09"), "2030-06-09")
})

test("isActiveTarget and overrideKey", () => {
  assert.equal(isActiveTarget(statementCard(), CLOSED), true)
  assert.equal(isActiveTarget(statementCard(), EXPECTED), false)
  assert.equal(
    isActiveTarget(statementCard({ activeStatement: null }), CLOSED),
    false
  )
  assert.equal(isActiveTarget(card({ cycleMonth: "2030-06" }), LEGACY), true)
  assert.deepEqual(overrideKey(CLOSED), { statementId: "2030-05-20" })
  assert.deepEqual(overrideKey(LEGACY), { cycleMonth: "2030-06" })
})

// A legacy due-month row on a card that now has statement records: the server
// rejects every cycle-month save for such a card, so it never gets a legacy
// target.
test("resolveTarget: stranded legacy row never gets a legacy target", () => {
  const row = entry({ ccStatementKind: "legacy", ccCycleMonth: "2030-07" })
  // The next statement (no record yet) is due that month: create its
  // expected statement, which adopts the row.
  const noExpected = statementCard({
    expectedStatement: null,
    nextCloseDate: "2030-06-20",
    nextDueDate: "2030-07-15",
  })
  assert.deepEqual(resolveTarget(row, noExpected), {
    needsExpected: true,
    adoptMonth: "2030-07",
  })
  assert.equal(isDialogPlan(row, noExpected), true)
  // Another month, an expected statement already on record (the server
  // did not map the row to it), or a closed statement due that month:
  // a plain editable plan.
  const other = entry({ ccStatementKind: "legacy", ccCycleMonth: "2030-09" })
  assert.equal(resolveTarget(other, noExpected), null)
  assert.equal(isDialogPlan(other, noExpected), false)
  assert.equal(
    resolveTarget(row, statementCard({ nextDueDate: "2030-07-15" })),
    null
  )
  const closedDueJune = entry({
    ccStatementKind: "legacy",
    ccCycleMonth: "2030-06",
  })
  assert.equal(
    resolveTarget(
      closedDueJune,
      statementCard({ expectedStatement: null, nextDueDate: "2030-06-28" })
    ),
    null
  )
  // A card with no statement records keeps the legacy dialog.
  assert.equal(isDialogPlan(row, card()), true)
  assert.equal(isDialogPlan(row), true)
  // Orphans are never dialog plans.
  assert.equal(
    isDialogPlan(
      entry({ ccStatementKind: "orphan", ccStatementId: "2030-01-20" }),
      noExpected
    ),
    false
  )
})

test("planMatchesTarget: an adopting expected target matches the legacy row", () => {
  const adopting: CcOverrideTarget = { ...EXPECTED, adoptMonth: "2030-07" }
  const row = entry({ ccStatementKind: "legacy", ccCycleMonth: "2030-07" })
  assert.equal(planMatchesTarget(row, CARD, adopting), true)
  assert.equal(planMatchesTarget(row, CARD, EXPECTED), false)
  assert.equal(
    planMatchesTarget(
      entry({ ccStatementKind: "legacy", ccCycleMonth: "2030-08" }),
      CARD,
      adopting
    ),
    false
  )
  // The key sent to the server is unchanged.
  assert.deepEqual(overrideKey(adopting), { statementId: "2030-06-20" })
})

test("normalizeEstimate: what is previewed is what is sent", () => {
  assert.deepEqual(normalizeEstimate(""), {
    ok: true,
    value: null,
    amount: null,
  })
  assert.deepEqual(normalizeEstimate("  "), {
    ok: true,
    value: null,
    amount: null,
  })
  assert.deepEqual(normalizeEstimate("1,000"), {
    ok: true,
    value: "1000.00",
    amount: 1000,
  })
  assert.deepEqual(normalizeEstimate("$1,234.5"), {
    ok: true,
    value: "1234.50",
    amount: 1234.5,
  })
  assert.deepEqual(normalizeEstimate("=500+200"), {
    ok: true,
    value: "700.00",
    amount: 700,
  })
  for (const bad of [
    "12abc",
    "abc",
    "1.2.3",
    "0",
    "0.00",
    "-20",
    "=1-5",
    "=",
  ]) {
    assert.deepEqual(normalizeEstimate(bad), { ok: false }, bad)
  }
})
