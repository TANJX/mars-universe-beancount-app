// Merchant section: merge bundled defaults with user-defined entries.
// User entries win on key conflict (case-sensitive on `name`). Lets a user
// override a bundled brand's domain or aliases without redefining everything.

import { MERCHANT_DEFAULTS } from "./defaults/merchants"
import type { UIConfigWire } from "./schema"
import type { MerchantEntry, MerchantRegistry } from "./types"

export function resolveMerchants(
  user: UIConfigWire["merchants"]
): MerchantRegistry {
  const out: MerchantRegistry = {}
  for (const entry of MERCHANT_DEFAULTS) {
    out[entry.name] = entry
  }
  if (user) {
    for (const [name, fields] of Object.entries(user)) {
      const existing = out[name]
      const next: MerchantEntry = { name }
      if (fields?.domain !== undefined) next.domain = fields.domain
      else if (existing?.domain) next.domain = existing.domain
      if (fields?.aliases?.length) next.aliases = fields.aliases
      else if (existing?.aliases?.length) next.aliases = existing.aliases
      out[name] = next
    }
  }
  return out
}

// ── Lookup helpers (consume a MerchantRegistry — no React) ───────────────

/** Lower-cased name → entry. Used by exact and substring match. */
export function buildLookupTable(
  registry: MerchantRegistry
): Map<string, MerchantEntry> {
  const m = new Map<string, MerchantEntry>()
  for (const entry of Object.values(registry)) {
    m.set(entry.name.toLowerCase(), entry)
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        m.set(alias.toLowerCase(), entry)
      }
    }
  }
  return m
}
