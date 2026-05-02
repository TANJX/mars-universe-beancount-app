import { z } from "zod"

import {
  CCCardSchema,
  PlanGridResponseSchema,
  PlanSettingsSchema,
} from "@/lib/plan/schemas"

const BASE = "/api/ext"

export class PlannerApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message)
    this.name = "PlannerApiError"
  }
}

async function plannerFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const url = `${BASE}/${path.replace(/^\//, "")}`
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new PlannerApiError(
      `Network error contacting fava (${url}). Is \`just fava\` running?`,
      undefined,
      url
    )
  }
  if (!res.ok) {
    throw new PlannerApiError(
      `Planner endpoint returned HTTP ${res.status} for ${url}`,
      res.status,
      url
    )
  }
  // LedgerDataApi endpoints return raw JSON via `json.dumps(...)`. Some Flask
  // configurations send these with text/html Content-Type, which `res.json()`
  // still accepts in modern browsers — but be defensive.
  const text = await res.text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PlannerApiError(`Response was not JSON (${url})`, res.status, url)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new PlannerApiError(
      `Response failed schema validation (${url}): ${parsed.error.message}`,
      res.status,
      url
    )
  }
  return parsed.data
}

export function fetchPlanGrid(params: { start?: string; end?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.start) qs.set("start", params.start)
  if (params.end) qs.set("end", params.end)
  const suffix = qs.toString() ? `?${qs.toString()}` : ""
  return plannerFetch(`plan_grid${suffix}`, PlanGridResponseSchema)
}

export function fetchCcCards() {
  return plannerFetch("cc_cards", z.array(CCCardSchema))
}

export function fetchPlanSettings() {
  return plannerFetch("plan_settings", PlanSettingsSchema)
}

async function plannerPost<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const url = `${BASE}/${path.replace(/^\//, "")}`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    throw new PlannerApiError(`Network error contacting ${url}`, undefined, url)
  }
  if (!res.ok) {
    throw new PlannerApiError(`HTTP ${res.status} for ${url}`, res.status, url)
  }
  const text = await res.text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PlannerApiError(`Response was not JSON (${url})`, res.status, url)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new PlannerApiError(
      `Response failed schema validation (${url}): ${parsed.error.message}`,
      res.status,
      url
    )
  }
  return parsed.data
}

export interface PlanWriteInput {
  id?: string
  date: string
  account: string
  amount?: string
  description?: string
  state?: "todo" | "pending" | null
  transferId?: string | null
  ccCardRef?: string | null
  ccCycleMonth?: string | null
}

const SaveResponseSchema = z.object({ id: z.string() }).loose()
const EmptyResponseSchema = z.object({}).loose()

export function savePlan(plan: PlanWriteInput) {
  return plannerPost("plan_save", plan, SaveResponseSchema)
}

export function deletePlan(id: string) {
  return plannerPost("plan_delete", { id }, EmptyResponseSchema)
}

export function savePlanSettings(settings: unknown) {
  return plannerPost("plan_settings_save", settings, EmptyResponseSchema)
}

export function saveCcCard(record: unknown) {
  return plannerPost("cc_card_save", record, EmptyResponseSchema)
}

export function deleteCcCard(accountPath: string) {
  return plannerPost("cc_card_delete", { accountPath }, EmptyResponseSchema)
}

export interface TransferWriteInput {
  id?: string
  date: string
  fromAccount: string
  toAccount: string
  amount: string
  description?: string
  state?: "todo" | "pending" | null
}

export function saveTransfer(transfer: TransferWriteInput) {
  return plannerPost("transfer_save", transfer, SaveResponseSchema)
}

export function deleteTransfer(id: string) {
  return plannerPost("transfer_delete", { id }, EmptyResponseSchema)
}

export interface CcOverrideSaveInput {
  cardAccountPath: string
  cycleMonth: string
  plans: Array<{
    id?: string
    date: string
    account: string
    amount: string
    description?: string
    state?: "todo" | "pending" | null
  }>
}

const CcOverrideResponseSchema = z
  .object({ plans: z.array(z.unknown()) })
  .loose()

export function saveCcOverride(input: CcOverrideSaveInput) {
  return plannerPost("cc_override_save", input, CcOverrideResponseSchema)
}
