// React Query hook for the /runway page.
//
// `/api/ext/runway_data` returns every person in `config/runway.yaml`, already
// resolved (defaults merged, includes read, ledger balances filled in). The
// simulation itself runs client-side in `lib/runway/engine`. Read-only.

"use client"

import { useQuery } from "@tanstack/react-query"

import { parseRunwayData } from "@/lib/runway/config"
import type { RunwayData } from "@/lib/runway/types"

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
