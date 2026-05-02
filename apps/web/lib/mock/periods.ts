import type { Period, PeriodPresetId } from "@/lib/types/views"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Compute the canonical preset for the given id, anchored at today. */
export function getPreset(id: PeriodPresetId): Period {
  const today = new Date()
  switch (id) {
    case "mtd":
      return {
        id,
        label: "Month to date",
        range: `${MONTHS[today.getMonth()]} 1 – ${monthDay(today)}, ${today.getFullYear()}`,
      }
    case "this-month":
      return {
        id,
        label: "This month",
        range: `${MONTHS[today.getMonth()]} ${today.getFullYear()}`,
      }
    case "last-month": {
      const d = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return { id, label: "Last month", range: monthLabel(d) }
    }
    case "qtd": {
      const q = Math.floor(today.getMonth() / 3) + 1
      return {
        id,
        label: "This quarter",
        range: `Q${q} ${today.getFullYear()}`,
      }
    }
    case "ytd":
      return {
        id,
        label: "YTD",
        range: `Jan 1 – ${monthDay(today)}, ${today.getFullYear()}`,
      }
    case "last-12": {
      const start = new Date(today.getFullYear(), today.getMonth() - 11, 1)
      return {
        id,
        label: "Last 12 months",
        range: `${monthLabel(start)} – ${monthLabel(today)}`,
      }
    }
    case "custom":
      return { id, label: "Custom", range: "" }
  }
}

/** Snapshot of all presets, computed at call time. */
export function listPresets(): Period[] {
  return [
    getPreset("mtd"),
    getPreset("this-month"),
    getPreset("last-month"),
    getPreset("qtd"),
    getPreset("ytd"),
    getPreset("last-12"),
    getPreset("custom"),
  ]
}

/** Back-compat alias for callers that import PRESETS. */
export const PRESETS: Period[] = listPresets()
