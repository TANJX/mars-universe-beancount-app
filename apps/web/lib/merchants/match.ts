// Stage 3 + 4 of the merchant resolver: payee → registry entry.
// Pure function — takes the merged merchant registry as input so callers
// (React components) can supply it from `useResolvedUIConfig()`.

import { buildLookupTable } from "@/lib/config/merchants"
import type { MerchantEntry, MerchantRegistry } from "@/lib/config/types"

import { matchPayeePattern, RAIL_PREFIXES } from "./patterns"

// The payment rails live in `patterns.ts` so the prefix-is-merchant rule and
// this strip list can never disagree about what counts as a rail. `Tm *` is
// intentionally absent — `patterns.ts` resolves it to Ticketmaster directly,
// and stripping it would let the residual (the event name) win.
const PREFIX_STRIPS = RAIL_PREFIXES

const SUFFIX_STRIPS = [
  // Wallet tag the issuer appends to the descriptor. BofA writes it with no
  // separator at all — "Acme 1856 West New Yorknjapple Pay Ending in 2059"
  // — so the leading boundary has to be optional. Left unstripped, the
  // substring stage finds "apple" inside "yorknjapple" and books a grocery
  // run to Apple.
  /\s*apple\s*pay\s+ending\s+in\s+\d+\s*$/i,
  /\s*(google|samsung)\s*pay\s+ending\s+in\s+\d+\s*$/i,
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
  // Tails stack ("... 888-555-1212 Nj"), and stripping one can expose the
  // next, so run the set to a fixed point rather than once each.
  for (let pass = 0; pass < SUFFIX_STRIPS.length; pass++) {
    const before = out
    for (const re of SUFFIX_STRIPS) {
      out = out.replace(re, "").trim()
    }
    if (out === before) break
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

  // Longest-substring match against name or alias, anchored to word
  // boundaries. An unanchored `includes` matches brand names that merely
  // happen to fall inside a longer word, which is how "Acme 1856 West New
  // Yorknj..." resolved to Apple.
  let best: { needle: string; entry: MerchantEntry } | null = null
  for (const [needle, entry] of lookup) {
    if (!containsAtWordBoundary(cleaned, needle)) continue
    if (!best || needle.length > best.needle.length) {
      best = { needle, entry }
    }
  }
  return best?.entry ?? null
}

const ALNUM = /[a-z0-9]/

/** Below this length a needle must match a whole word. "citi" inside
 * "citizen" or "mta" inside "amtat" is noise; "starbucks" inside
 * "starbucksse" is not. */
const SHORT_NEEDLE = 5

/**
 * `haystack.includes(needle)`, but the hit must START on a word boundary.
 * Both strings are already lowercased; punctuation counts as a boundary, so
 * "grubhub*tsaoc" still matches "grubhub".
 *
 * The left edge is the one that matters. Banks concatenate a trailing
 * qualifier onto the brand without a separator, so the real merchant is a
 * word *prefix* ("Paypal *Starbucksse", "Wholefds Egw") — requiring a right
 * boundary too would throw those away. The failure mode this guards against
 * is the mirror image: a brand appearing as a word *suffix* by accident,
 * which is how "Acme 1856 West New Yorknj..." resolved to Apple.
 *
 * Short needles are held to the stricter both-sides rule, since a three- or
 * four-letter brand lands inside ordinary words too easily.
 */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
  const strict = needle.length < SHORT_NEEDLE
  let from = 0
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from)
    if (i < 0) return false
    const before = i === 0 ? "" : haystack[i - 1]
    if (before === "" || !ALNUM.test(before)) {
      if (!strict) return true
      const after = haystack[i + needle.length] ?? ""
      if (after === "" || !ALNUM.test(after)) return true
    }
    from = i + 1
  }
  return false
}
