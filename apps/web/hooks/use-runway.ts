// React Query hook for the /runway page.
//
// `/api/ext/runway_data` returns every person in `config/runway.yaml`, already
// resolved (defaults merged, includes read, ledger balances filled in). The
// simulation itself runs client-side in `lib/runway/engine`. Read-only.

"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { parseRunwayData } from "@/lib/runway/config"
import type { SaveBody } from "@/lib/runway/drafts"
import {
  type HistoryRange,
  parseRunwayHistory,
  type RunwayHistory,
} from "@/lib/runway/history"
import type { RunwayData, RunwayIssue } from "@/lib/runway/types"

const BASE = "/api/ext"

async function call(path: string): Promise<unknown> {
  const url = `${BASE}/${path}`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new Error(
      `Network error contacting fava (${url}). Is \`just fava\` running?`
    )
  }
  if (!res.ok)
    throw new Error(`Runway endpoint returned HTTP ${res.status} for ${url}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Response was not JSON (${url})`)
  }
}

export function useRunwayData() {
  return useQuery<RunwayData>({
    queryKey: ["runway"],
    queryFn: async () => parseRunwayData(await call("runway_data")),
    staleTime: 60_000,
  })
}

/** Past months for the chart's history range, fetched only once a range is
 * picked. Never throws: a missing endpoint or a bad payload resolves to
 * null, which the page shows as "no history" and draws the plan alone. */
export function useRunwayHistory(range: HistoryRange) {
  return useQuery<RunwayHistory | null>({
    queryKey: ["runway-history", range],
    queryFn: async () => {
      try {
        return parseRunwayHistory(await call(`runway_history?months=${range}`))
      } catch {
        return null
      }
    },
    enabled: range > 0,
    staleTime: 60_000,
    retry: false,
  })
}

/** A rejected save. `status` 0 means the server could not be reached; 409
 * means the YAML changed since the page loaded; 422 carries `issues`. */
export class RunwaySaveError extends Error {
  status: number
  issues: RunwayIssue[]
  constructor(message: string, status: number, issues: RunwayIssue[] = []) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

export interface RunwaySaveResult {
  status: "ok"
  written: string[]
  version: string
}

async function postSave(body: SaveBody): Promise<RunwaySaveResult> {
  let res: Response
  try {
    res = await fetch(`${BASE}/runway_save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    throw new RunwaySaveError("Couldn't reach the ledger server.", 0)
  }
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // An HTML error page; the status says enough.
  }
  if (!res.ok)
    throw new RunwaySaveError(
      typeof json.message === "string" ? json.message : `HTTP ${res.status}`,
      res.status,
      Array.isArray(json.issues) ? (json.issues as RunwayIssue[]) : []
    )
  return json as unknown as RunwaySaveResult
}

/** Saves page edits, then reloads the runway data. */
export function useRunwaySave() {
  const qc = useQueryClient()
  return useMutation<RunwaySaveResult, RunwaySaveError, SaveBody>({
    mutationFn: postSave,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["runway"] })
      // Sleeve rules live in the same files, so history can change too.
      void qc.invalidateQueries({ queryKey: ["runway-history"] })
    },
  })
}
