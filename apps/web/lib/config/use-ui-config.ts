"use client"

import { useQuery } from "@tanstack/react-query"

import { UIConfigSchema, type UIConfigWire } from "./schema"

const ENDPOINT = "/api/ext/get_ui_config"

async function fetchUIConfig(): Promise<UIConfigWire> {
  const res = await fetch(ENDPOINT)
  if (!res.ok) return {}
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return {}
  }
  const parsed = UIConfigSchema.safeParse(raw)
  if (!parsed.success) {
    if (typeof console !== "undefined") {
      console.warn("ui-config: schema validation failed", parsed.error.message)
    }
    return {}
  }
  return parsed.data
}

/** Raw user UI config — pre-merge with defaults. Most call sites should
 * use `useResolvedUIConfig()` from `./index` instead. */
export function useUIConfig() {
  return useQuery({
    queryKey: ["ui_config"],
    queryFn: fetchUIConfig,
    staleTime: 5 * 60_000,
  })
}
