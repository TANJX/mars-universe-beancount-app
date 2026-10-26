// React Query hooks for the /fire page.
//
// `/api/ext/fire_data` returns the ledger snapshot, the user's
// `config/fire.yaml`, and saved scenarios in one round trip. Scenario saves
// and deletes are POSTs that invalidate it.

"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { type FireData, parseFireData } from "@/lib/fire/config"
import type { Inputs, Scenario } from "@/lib/fire/types"

const BASE = "/api/ext"
const KEY = ["fire"]

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${BASE}/${path}`
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(
      `Network error contacting fava (${url}). Is \`just fava\` running?`
    )
  }
  if (!res.ok)
    throw new Error(`FIRE endpoint returned HTTP ${res.status} for ${url}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Response was not JSON (${url})`)
  }
}

function post(path: string, body: unknown) {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function useFireData() {
  return useQuery<FireData>({
    queryKey: KEY,
    queryFn: async () => parseFireData(await call("fire_data")),
    staleTime: 60_000,
  })
}

export function useSaveScenario() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: { id?: string; name: string; inputs: Inputs }) =>
      post("fire_scenario_save", {
        id: s.id,
        name: s.name,
        overrides: s.inputs,
      }) as Promise<Scenario>,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteScenario() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => post("fire_scenario_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
