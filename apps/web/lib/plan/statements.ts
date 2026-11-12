// Pure helpers that decide which card statement an override targets.
//
// A card with statement records ("statement mode") is planned per statement:
// a closed one (a fact, keyed by its closing date) or the expected one (the
// next statement, not closed yet). A card with no records keeps the legacy
// cycle-month keying.
//
// Only relative and type-only imports, so `node --test` can load this file.

import { parseAmount } from "./format"
import type {
  CCCard,
  CcExpectedStatement,
  CcStatement,
  GridEntry,
} from "./schemas"

// `adoptMonth`: the dialog was opened from a legacy due-month row that the
// expected statement (just created for it) takes over. The server maps that
// row to the statement on its next read; until the grid refetches, the row is
// matched by its month.
export type CcOverrideTarget =
  | {
      mode: "statement"
      statementId: string
      kind: "closed" | "expected"
      adoptMonth?: string
    }
  | { mode: "legacy"; cycleMonth: string }

export type ResolvedTarget =
  | { target: CcOverrideTarget }
  | { needsExpected: true; adoptMonth?: string }

export type EntryStatementKind = "closed" | "expected" | "legacy" | "orphan"

type EntryRef = Pick<
  GridEntry,
  "kind" | "ccCardRef" | "ccCycleMonth" | "ccStatementId" | "ccStatementKind"
>

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function num(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

// An API that predates statements sends no ccStatementKind: a row carrying a
// cycle month is then a legacy row.
export function entryStatementKind(entry: EntryRef): EntryStatementKind | null {
  return entry.ccStatementKind ?? (entry.ccCycleMonth ? "legacy" : null)
}

// An override plan the dialog owns. Orphans (their statement is gone) behave
// as plain editable plans.
export function isCcTaggedPlan(entry: EntryRef): boolean {
  if (entry.kind !== "plan" || !entry.ccCardRef) return false
  const kind = entryStatementKind(entry)
  return kind === "closed" || kind === "expected" || kind === "legacy"
}

// A legacy due-month row on a card that has statement records, which the
// server could not map to one statement. A cycle-month override is always
// rejected for such a card, so the row must never get a legacy target.
// When its month is the month the next (not yet recorded) statement is due,
// and no closed statement is due that month, creating the expected statement
// lets the server adopt the row: `needsExpected`. Otherwise null: the row is
// a plain editable plan.
function resolveStrandedLegacy(
  cycleMonth: string,
  card: CCCard
): ResolvedTarget | null {
  if (card.expectedStatement) return null
  if (card.nextDueDate?.slice(0, 7) !== cycleMonth) return null
  const closedDueThatMonth = [
    ...(card.activeStatement ? [card.activeStatement] : []),
    ...(card.statements ?? []),
  ].some((s) => s.effectiveDueDate.slice(0, 7) === cycleMonth)
  if (closedDueThatMonth) return null
  return { needsExpected: true, adoptMonth: cycleMonth }
}

// `needsExpected`: a row of a statement-mode card whose statement has no
// expected record yet. The caller creates one, then targets it.
export function resolveTarget(
  entry: EntryRef,
  card?: CCCard | null
): ResolvedTarget | null {
  if (!entry.ccCardRef) return null
  const kind = entryStatementKind(entry)
  if (kind === "closed" || kind === "expected") {
    if (entry.ccStatementId) {
      return {
        target: { mode: "statement", statementId: entry.ccStatementId, kind },
      }
    }
    return kind === "expected" ? { needsExpected: true } : null
  }
  if (kind === "legacy" && entry.ccCycleMonth) {
    if (card?.hasStatements) {
      return resolveStrandedLegacy(entry.ccCycleMonth, card)
    }
    return { target: { mode: "legacy", cycleMonth: entry.ccCycleMonth } }
  }
  return null
}

// An override plan that opens the override dialog: tagged, and the dialog has
// a statement (or legacy cycle) to target for it. Anything else is edited
// inline like a plain plan.
export function isDialogPlan(entry: EntryRef, card?: CCCard | null): boolean {
  return isCcTaggedPlan(entry) && resolveTarget(entry, card) !== null
}

// The target for an expected statement the caller just created.
export function expectedTarget(
  expected: CcExpectedStatement,
  adoptMonth?: string
): CcOverrideTarget {
  return {
    mode: "statement",
    statementId: expected.id,
    kind: "expected",
    ...(adoptMonth ? { adoptMonth } : {}),
  }
}

export function findClosedStatement(
  card: CCCard,
  statementId: string
): CcStatement | null {
  if (card.activeStatement?.id === statementId) return card.activeStatement
  return card.statements?.find((s) => s.id === statementId) ?? null
}

export function findExpectedStatement(
  card: CCCard,
  statementId: string
): CcExpectedStatement | null {
  return card.expectedStatement?.id === statementId
    ? card.expectedStatement
    : null
}

// True when the target is the cycle the card's paidThisCycle / remaining
// fields describe: the active closed statement, or the active legacy cycle.
export function isActiveTarget(
  card: CCCard,
  target: CcOverrideTarget
): boolean {
  if (target.mode === "legacy") return card.cycleMonth === target.cycleMonth
  return (
    target.kind === "closed" && card.activeStatement?.id === target.statementId
  )
}

// Due date of a legacy cycle month from the card's payment-due day (-1 is the
// last day; a day past the month's end clamps to it).
export function legacyPaymentDate(
  card: CCCard,
  cycleMonth: string
): string | null {
  if (!card.paymentDueDay) return null
  const [y, m] = cycleMonth.split("-").map(Number)
  if (!y || !m) return null
  const lastDay = new Date(y, m, 0).getDate()
  const day =
    card.paymentDueDay === -1 ? lastDay : Math.min(card.paymentDueDay, lastDay)
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// Default date for new payment splits.
export function targetPaymentDate(
  card: CCCard,
  target: CcOverrideTarget,
  rowDate: string
): string {
  if (target.mode === "legacy") {
    return legacyPaymentDate(card, target.cycleMonth) ?? rowDate
  }
  if (target.kind === "closed") {
    return (
      findClosedStatement(card, target.statementId)?.effectiveDueDate ?? rowDate
    )
  }
  return findExpectedStatement(card, target.statementId)?.dueDate ?? rowDate
}

// What the dialog proposes to pay before any override exists. overrideTotal
// is deliberately not used: existing override plans are summed by the dialog.
export function defaultPayTotal(
  card: CCCard,
  target: CcOverrideTarget
): number {
  if (target.mode === "legacy") {
    const stmt = num(card.statementBalance) ?? 0
    return isActiveTarget(card, target) ? (num(card.remaining) ?? stmt) : stmt
  }
  if (target.kind === "closed") {
    const stmt = num(
      findClosedStatement(card, target.statementId)?.statementBalance
    )
    if (isActiveTarget(card, target)) {
      return num(card.lockedAmount) ?? num(card.remaining) ?? stmt ?? 0
    }
    return Math.max(0, stmt ?? 0)
  }
  return (
    num(findExpectedStatement(card, target.statementId)?.estimatedBalance) ??
    num(card.computedForecast) ??
    0
  )
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map(Number)
  if (!y || !m || m > 12) return yyyymm
  return `${MONTHS[m - 1]} ${y}`
}

// A statement is labelled by its closing month.
export function statementLabel(target: CcOverrideTarget): string {
  if (target.mode === "legacy") return monthLabel(target.cycleMonth)
  return `${monthLabel(target.statementId.slice(0, 7))} statement`
}

// `entry.ccStatementId` is the id the server resolved, so a legacy row the
// server mapped to a statement at read time matches that statement.
export function planMatchesTarget(
  entry: EntryRef,
  cardPath: string,
  target: CcOverrideTarget
): boolean {
  if (entry.kind !== "plan" || entry.ccCardRef !== cardPath) return false
  if (target.mode === "statement") {
    if (entry.ccStatementId) return entry.ccStatementId === target.statementId
    return (
      !!target.adoptMonth &&
      entryStatementKind(entry) === "legacy" &&
      entry.ccCycleMonth === target.adoptMonth
    )
  }
  return entry.ccCycleMonth === target.cycleMonth && !entry.ccStatementId
}

// The key fields of a cc_override_save body for this target.
export function overrideKey(
  target: CcOverrideTarget
): { statementId: string } | { cycleMonth: string } {
  return target.mode === "statement"
    ? { statementId: target.statementId }
    : { cycleMonth: target.cycleMonth }
}

// The estimated-balance field of an expected statement. The server parses it
// as a plain decimal, so the value is normalised here and what is previewed is
// what gets stored: "$" and thousands separators are dropped, an "=" formula
// is evaluated, and the result is sent with 2 decimals. Blank clears the
// estimate (the ledger forecast is used). Zero or less is not an estimate.
export type EstimateInput =
  | { ok: true; value: string | null; amount: number | null }
  | { ok: false }

const PLAIN_NUMBER = /^(\d+\.?\d*|\.\d+)$/

export function normalizeEstimate(raw: string): EstimateInput {
  const text = raw.replace(/[$,\s]/g, "")
  if (text === "") return { ok: true, value: null, amount: null }
  if (!text.startsWith("=") && !PLAIN_NUMBER.test(text)) return { ok: false }
  const amount = parseAmount(text)
  if (amount == null) return { ok: false }
  const rounded = Math.round(amount * 100) / 100
  if (!(rounded > 0)) return { ok: false }
  return { ok: true, value: rounded.toFixed(2), amount: rounded }
}
