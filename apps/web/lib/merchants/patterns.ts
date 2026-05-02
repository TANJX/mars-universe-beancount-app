// Stage 3 of the resolver: regex rules that pre-process noisy payees before
// the alias / cleanPayee path. Two rule shapes:
//
//   1. "Issuer-as-merchant prefix" — when a known prefix means the prefix
//      itself is the brand. Example: `Tm *<event>` is a Ticketmaster
//      purchase; the text after `Tm *` is the event name, not the merchant.
//      Returns the literal merchant name to look up.
//
//   2. "Token extraction" — bank wires arrive as `Public Service Des:pseg
//      Id:xxxxx Indn:foo`. The merchant ID lives between `Des:` and the
//      next segment. We extract it; the resolver then looks up the token
//      across the merged merchants registry (`name` + `aliases`,
//      case-insensitive). Lets the registry itself be the single source of
//      truth — no parallel ACH map to keep in sync.
//
// Add new rules here as new noisy payee shapes are encountered.

export interface PatternResult {
  /** When set, look up this exact merchant `name` in the registry. */
  name?: string
  /** When set, look up this token across registry `name`/`aliases` (lower). */
  token?: string
}

interface PayeePattern {
  re: RegExp
  resolve: PatternResult | ((m: RegExpMatchArray) => PatternResult | null)
}

const PATTERNS: PayeePattern[] = [
  // Ticketmaster — `Tm *<event>` prefix. The merchant is always TM, never
  // what follows.
  { re: /^Tm \*/i, resolve: { name: "Ticketmaster" } },

  // ACH wire — `Des:<merchant>` segment between `Des:` and `Id:` / `Indn:`.
  {
    re: /\bDes:\s*([A-Za-z0-9 .&_-]+?)(?=\s+(?:Id:|Indn:|Tel:|$))/i,
    resolve: (m) => {
      const token = m[1]
        ?.toLowerCase()
        .trim()
        .replace(/[\s.]+/g, " ")
      return token ? { token } : null
    },
  },
]

/** Run the regex rules against a payee. Returns a pattern result or null. */
export function matchPayeePattern(payee: string): PatternResult | null {
  for (const { re, resolve } of PATTERNS) {
    const m = payee.match(re)
    if (!m) continue
    if (typeof resolve === "function") {
      const r = resolve(m)
      if (r) return r
    } else {
      return resolve
    }
  }
  return null
}
