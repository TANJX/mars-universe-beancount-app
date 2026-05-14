"use client"

import * as React from "react"
import { parseAsString, useQueryStates } from "nuqs"

import { getPreset } from "@/lib/mock/periods"
import { makeCustomPeriod, parseLocalDate } from "@/lib/fava/periods"
import type {
  Conversion,
  Density,
  Period,
  PeriodPresetId,
} from "@/lib/types/views"

interface UIState {
  density: Density
  setDensity: (d: Density) => void
  period: Period
  setPeriod: (next: Period | PeriodPresetId) => void
  conversion: Conversion
  setConversion: (c: Conversion) => void
}

const UIStateContext = React.createContext<UIState | null>(null)

const DENSITY_KEY = "mars-density"
const densityListeners = new Set<() => void>()

let densityOverride: Density | null = null

function readStoredDensity(): Density {
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY)
    return raw === "compact" || raw === "comfortable" ? raw : "comfortable"
  } catch {
    return "comfortable"
  }
}

function readDensitySnapshot(): Density {
  if (typeof window === "undefined") return "comfortable"
  return densityOverride ?? readStoredDensity()
}

function subscribeDensity(onStoreChange: () => void): () => void {
  densityListeners.add(onStoreChange)

  if (typeof window === "undefined") {
    return () => {
      densityListeners.delete(onStoreChange)
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== DENSITY_KEY) return
    densityOverride = null
    onStoreChange()
  }

  window.addEventListener("storage", onStorage)

  return () => {
    densityListeners.delete(onStoreChange)
    window.removeEventListener("storage", onStorage)
  }
}

function emitDensityChange() {
  for (const onStoreChange of densityListeners) {
    onStoreChange()
  }
}

function getDensityServerSnapshot(): Density {
  return "comfortable"
}

const VALID_PRESETS: PeriodPresetId[] = [
  "mtd",
  "this-month",
  "last-month",
  "qtd",
  "ytd",
  "last-12",
  "all",
  "custom",
]

function applyPeriodParams(params: URLSearchParams, period: Period) {
  params.set("p", period.id)
  if (period.from) params.set("from", period.from)
  else params.delete("from")
  if (period.to) params.set("to", period.to)
  else params.delete("to")
}

export function withPeriodHref(href: string, period: Period): string {
  const url = new URL(href, "http://ledger.local")
  applyPeriodParams(url.searchParams, period)
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
}

export function UIStateProvider({ children }: { children: React.ReactNode }) {
  const density = React.useSyncExternalStore(
    subscribeDensity,
    readDensitySnapshot,
    getDensityServerSnapshot
  )
  // Period URL state: ?p=mtd / ?p=custom&from=2026-04-01&to=2026-04-25
  const [{ p, from, to }, setUrlPeriod] = useQueryStates(
    {
      p: parseAsString.withDefault("mtd"),
      from: parseAsString.withDefault(""),
      to: parseAsString.withDefault(""),
    },
    { history: "replace" }
  )
  // Conversion URL state: ?c=at_cost | ?c=at_value (default).
  const [{ c }, setUrlConversion] = useQueryStates(
    { c: parseAsString.withDefault("at_value") },
    { history: "replace" }
  )

  const setDensity = React.useCallback((d: Density) => {
    densityOverride = d
    try {
      window.localStorage.setItem(DENSITY_KEY, d)
    } catch {}
    emitDensityChange()
  }, [])

  const period = React.useMemo<Period>(() => {
    const id = (
      VALID_PRESETS.includes(p as PeriodPresetId) ? p : "mtd"
    ) as PeriodPresetId
    if (id === "custom" && from && to) {
      return makeCustomPeriod(parseLocalDate(from), parseLocalDate(to))
    }
    return getPreset(id)
  }, [p, from, to])

  const setPeriod = React.useCallback(
    (next: Period | PeriodPresetId) => {
      const period = typeof next === "string" ? getPreset(next) : next
      setUrlPeriod({
        p: period.id,
        from: period.from ?? "",
        to: period.to ?? "",
      })
    },
    [setUrlPeriod]
  )

  const conversion: Conversion = c === "at_cost" ? "at_cost" : "at_value"
  const setConversion = React.useCallback(
    (next: Conversion) => {
      setUrlConversion({ c: next })
    },
    [setUrlConversion]
  )

  const value = React.useMemo(
    () => ({
      density,
      setDensity,
      period,
      setPeriod,
      conversion,
      setConversion,
    }),
    [density, setDensity, period, setPeriod, conversion, setConversion]
  )

  return (
    <UIStateContext.Provider value={value}>{children}</UIStateContext.Provider>
  )
}

export function useUIState(): UIState {
  const ctx = React.useContext(UIStateContext)
  if (!ctx) {
    throw new Error("useUIState must be used inside <UIStateProvider>")
  }
  return ctx
}

export function usePeriodHref(): (href: string) => string {
  const { period } = useUIState()

  return React.useCallback((href: string) => withPeriodHref(href, period), [
    period,
  ])
}
