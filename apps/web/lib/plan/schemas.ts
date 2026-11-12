import { z } from "zod"

export const StateFlag = z.enum(["todo", "pending"]).nullable().optional()

export const PastState = z.enum(["realized", "unrealized"])

export const EntryKind = z.enum([
  "cleared",
  "scheduled",
  "plan",
  "cc-locked",
  "cc-forecast",
])

export const CcStatementKind = z.enum([
  "closed",
  "expected",
  "legacy",
  "orphan",
])

// A closed card statement: a fact recorded by the fetch command. Identity is
// (account, id) where id is the closing date.
export const CcStatementSchema = z
  .object({
    kind: z.literal("closed"),
    account: z.string(),
    id: z.string(),
    statementBalance: z.string(),
    dueDate: z.string().nullable(),
    minimumPayment: z.string().nullable(),
    source: z.string(),
    capturedAt: z.string(),
    effectiveDueDate: z.string(),
  })
  .loose()

// The next statement of a card, not closed yet: planner intent. id and
// dueDate are predictions.
export const CcExpectedStatementSchema = z
  .object({
    kind: z.literal("expected"),
    account: z.string(),
    id: z.string(),
    dueDate: z.string().nullable(),
    estimatedBalance: z.string().nullable(),
    afterId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .loose()

export const PlanSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    account: z.string(),
    amount: z.string(),
    description: z.string(),
    state: StateFlag,
    transferId: z.string().nullable().optional(),
    ccCardRef: z.string().nullable().optional(),
    ccCycleMonth: z.string().nullable().optional(),
    ccStatementId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .loose()

export const TransferSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    fromAccount: z.string(),
    toAccount: z.string(),
    amount: z.string(),
    description: z.string(),
    state: StateFlag,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .loose()

export const CCCardRecordSchema = z
  .object({
    accountPath: z.string(),
    fundingAccount: z.string().nullable().optional(),
    statementCloseDay: z.number().nullable().optional(),
    paymentDueDay: z.number().nullable().optional(),
    statementBalance: z.string().nullable().optional(),
    currentBalance: z.string().nullable().optional(),
    lastClosedDate: z.string().nullable().optional(),
    minimumPaymentOnly: z.boolean().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .loose()

export const CCCardSchema = CCCardRecordSchema.extend({
  displayName: z.string(),
  isConfigured: z.boolean(),
  hasMonthlyInputs: z.boolean(),
  // Active-cycle derived fields (server-computed; nullable when the card
  // isn't configured well enough to anchor a cycle).
  paidThisCycle: z.string().nullable().optional(),
  remaining: z.string().nullable().optional(),
  cycleStartDate: z.string().nullable().optional(),
  cycleEndDate: z.string().nullable().optional(),
  cycleMonth: z.string().nullable().optional(),
  statementBalanceStale: z.boolean().nullable().optional(),
  // Statement-mode fields. All optional so the page still parses against an
  // API that has not been restarted.
  hasStatements: z.boolean().optional(),
  activeStatement: CcStatementSchema.nullable().optional(),
  expectedStatement: CcExpectedStatementSchema.nullable().optional(),
  statements: z.array(CcStatementSchema).optional(),
  nextCloseDate: z.string().nullable().optional(),
  nextDueDate: z.string().nullable().optional(),
  statementExpectedSince: z.string().nullable().optional(),
  lockedAmount: z.string().nullable().optional(),
  lockedSource: z.enum(["minimum", "balance"]).nullable().optional(),
  overrideTotal: z.string().nullable().optional(),
  computedForecast: z.string().nullable().optional(),
})

export const PlanSettingsSchema = z
  .object({
    bankFloor: z.string(),
    bankPanel: z
      .object({
        bankOrder: z.array(z.string()),
        hiddenBanks: z.array(z.string()),
        excludedFromTotalBanks: z.array(z.string()),
      })
      .loose(),
  })
  .loose()

export const MatchedCcPlanSchema = z
  .object({
    ccCardRef: z.string(),
    ccCycleMonth: z.string().nullable().optional(),
    ccStatementId: z.string().nullable().optional(),
    displayName: z.string(),
  })
  .loose()

export const GridEntrySchema = z
  .object({
    id: z.string(),
    kind: EntryKind,
    amount: z.string(),
    description: z.string(),
    state: StateFlag,
    transferId: z.string().nullable().optional(),
    pastState: PastState.optional(),
    ccCardRef: z.string().nullable().optional(),
    ccCycleMonth: z.string().nullable().optional(),
    ccStatementId: z.string().nullable().optional(),
    ccStatementKind: CcStatementKind.nullable().optional(),
    // Set on a cleared bean entry when a CC-override plan claimed it during
    // match — lets the UI badge the bank txn with the card it pays.
    matchedCcPlan: MatchedCcPlanSchema.nullable().optional(),
  })
  .loose()

export const BankInfoSchema = z
  .object({
    account: z.string(),
    displayName: z.string(),
    startingBalance: z.string(),
  })
  .loose()

export const FloatingProjectionSchema = z
  .object({
    cardAccountPath: z.string(),
    displayName: z.string(),
    date: z.string(),
    amount: z.string(),
    kind: z.enum(["cc-locked", "cc-forecast"]),
    cycleMonth: z.string(),
    statementId: z.string().nullable().optional(),
    statementKind: z.enum(["closed", "expected", "legacy"]).optional(),
  })
  .loose()

export const CcStatementsResponseSchema = z
  .object({
    account: z.string(),
    hasStatements: z.boolean(),
    statements: z.array(CcStatementSchema),
    expectedStatement: CcExpectedStatementSchema.nullable(),
  })
  .loose()

export const PlanGridResponseSchema = z
  .object({
    banks: z.array(BankInfoSchema),
    rows: z.array(
      z
        .object({
          date: z.string(),
          entries: z.record(z.string(), z.array(GridEntrySchema)),
          balances: z.record(z.string(), z.string()),
          total: z.string(),
        })
        .loose()
    ),
    ccCards: z.array(CCCardSchema),
    floatingProjections: z.array(FloatingProjectionSchema),
    pastPlanCount: z.number(),
    todoCount: z.number(),
    pendingCount: z.number(),
    today: z.string(),
    start: z.string(),
    end: z.string(),
  })
  .loose()

export type Plan = z.infer<typeof PlanSchema>
export type Transfer = z.infer<typeof TransferSchema>
export type CCCardRecord = z.infer<typeof CCCardRecordSchema>
export type CCCard = z.infer<typeof CCCardSchema>
export type PlanSettings = z.infer<typeof PlanSettingsSchema>
export type GridEntry = z.infer<typeof GridEntrySchema>
export type BankInfo = z.infer<typeof BankInfoSchema>
export type FloatingProjection = z.infer<typeof FloatingProjectionSchema>
export type PlanGridResponse = z.infer<typeof PlanGridResponseSchema>
export type CcStatement = z.infer<typeof CcStatementSchema>
export type CcExpectedStatement = z.infer<typeof CcExpectedStatementSchema>
export type CcStatementsResponse = z.infer<typeof CcStatementsResponseSchema>

export interface CcOverrideSavePlan {
  id?: string
  date: string
  account: string
  amount: string
  description?: string
  state?: "todo" | "pending" | null
}
