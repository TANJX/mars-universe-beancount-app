// Stage 3 + 4 of the merchant resolver: payee → registry entry.
// Pure function — takes the merged merchant registry as input so callers
// (React components) can supply it from `useResolvedUIConfig()`.

import type { MerchantEntry, MerchantRegistry } from "@/lib/config/types"
import { buildLookupTable } from "@/lib/config/merchants"

import { matchPayeePattern } from "./patterns"

// `Tm *` is intentionally NOT here — it's owned by `patterns.ts` which
// resolves it to Ticketmaster directly. Stripping it would let the residual
// (the event name) win, which is wrong.
const PREFIX_STRIPS = [
  "Sq *",
  "Pp*",
  "Apple Pay - ",
  "Google Pay - ",
  "ACH — ",
  "ACH - ",
]

const SUFFIX_STRIPS = [
  /\s+\d{3,4}-\d{3,4}-\d{4}.*$/i, // phone numbers
  /\s+\d{2,4}\/\d{2}\/\d{2,4}\s*$/i, // dates
  /\s+#\d+\s*$/i, // terminal #1234
  /\s+\d{5}(-\d{4})?\s*$/i, // ZIP codes
  /\s+[A-Z]{2}\s*$/i, // trailing US state
]

/** Strip universal banking-format noise from a payee string so the cleaned
 * residual can be matched against merchant names. The strip rules encode
 * conventions (Apple Pay, Sq *, ZIP/state suffixes) — not user-specific data. */
export function cleanPayee(raw: string): string {
  let out = raw.trim()
  for (const p of PREFIX_STRIPS) {
    if (out.toLowerCase().startsWith(p.toLowerCase())) {
      out = out.slice(p.length).trim()
      break
    }
  }
  for (const re of SUFFIX_STRIPS) {
    out = out.replace(re, "").trim()
  }
  return out
}

/**
 * Resolve a payee string to a registry merchant entry, or null if no match.
 * Stages (first match wins):
 *   3a. Pattern stage — `Tm *` → Ticketmaster, ACH `Des:` token → registry
 *   4a. Cleaned payee, exact name/alias match
 *   4b. Cleaned payee, longest-substring match against name/alias
 */
export function matchMerchant(
  payee: string | undefined | null,
  registry: MerchantRegistry
): MerchantEntry | null {
  if (!payee) return null
  const lookup = buildLookupTable(registry)

  // ── Stage 3 ────────────────────────────────────────────────────────────
  const pattern = matchPayeePattern(payee)
  if (pattern) {
    if (pattern.name && registry[pattern.name]) return registry[pattern.name]
    if (pattern.token) {
      const hit = lookup.get(pattern.token)
      if (hit) return hit
    }
  }

  // ── Stage 4 ────────────────────────────────────────────────────────────
  const cleaned = cleanPayee(payee).toLowerCase()
  if (!cleaned) return null

  // Exact match (name or alias).
  const exact = lookup.get(cleaned)
  if (exact) return exact

  // Longest-substring match against name or alias.
  let best: { needle: string; entry: MerchantEntry } | null = null
  for (const [needle, entry] of lookup) {
    if (cleaned.includes(needle)) {
      if (!best || needle.length > best.needle.length) {
        best = { needle, entry }
      }
    }
  }
  return best?.entry ?? null
}
