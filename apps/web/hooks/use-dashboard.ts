"use client"

import { useQuery } from "@tanstack/react-query"
import { z } from "zod"

// GET /api/ext/dashboard (ledger-data-api, proxied through Fava). The spec
// files live in the ledger's config/dashboard/, which Fava's change poll does
// not watch, so the query also polls every 30s. useChangedPoll invalidates
// the whole query cache on ledger edits, which covers this key too.

const BASE = "/api/ext"

/** Loose on purpose: the render gate, not this schema, judges the spec. */
const DashboardEnvelope = z.object({
  spec: z.unknown().nullable().optional(),
  lkg: z.unknown().nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  dataError: z.string().nullable().optional(),
  version: z.string().optional(),
  issues: z.array(z.string()).optional(),
})

export interface DashboardResponse {
  spec: unknown
  lkg: unknown
  data: Record<string, unknown> | null
  /** Why `data` is null, when the endpoint could not build it. */
  dataError: string | null
  version: string
  /** Archived issue dates, newest first. */
  issues: string[]
}

const IssueEnvelope = z.object({ spec: z.unknown().nullable().optional() })

export class DashboardApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = "DashboardApiError"
  }
}

async function getJson(path: string): Promise<unknown> {
  const url = `${BASE}/${path}`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new DashboardApiError(
      `Network error contacting Fava (${url}). Is Fava running?`
    )
  }
  if (!res.ok)
    throw new DashboardApiError(
      `Dashboard endpoint returned HTTP ${res.status} (${url})`,
      res.status
    )
  try {
    return JSON.parse(await res.text())
  } catch {
    throw new DashboardApiError(`Response was not JSON (${url})`, res.status)
  }
}

export async function fetchDashboard(): Promise<DashboardResponse> {
  const parsed = DashboardEnvelope.safeParse(await getJson("dashboard"))
  if (!parsed.success)
    throw new DashboardApiError(
      `Dashboard response has the wrong shape: ${parsed.error.message}`
    )
  const r = parsed.data
  return {
    spec: r.spec ?? null,
    lkg: r.lkg ?? null,
    data: r.data ?? null,
    dataError: r.dataError ?? null,
    version: r.version ?? "",
    issues: r.issues ?? [],
  }
}

export async function fetchDashboardIssue(date: string): Promise<unknown> {
  const raw = await getJson(`dashboard_issue?date=${encodeURIComponent(date)}`)
  const parsed = IssueEnvelope.safeParse(raw)
  return parsed.success ? (parsed.data.spec ?? null) : null
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: fetchDashboard,
    refetchOnWindowFocus: false,
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

/** One archived issue's spec (for the issue scrubber); null when absent. */
export function useDashboardIssue(date: string | null) {
  return useQuery({
    queryKey: ["dashboard_issue", date],
    queryFn: () => fetchDashboardIssue(date as string),
    enabled: date !== null,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
