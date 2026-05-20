// Translate our client SearchQuery into fava's `filter=` parameter syntax,
// so link/tag/payee/text narrowings shrink the wire payload instead of just
// the post-fetch client filter. Reference:
//   https://beancount.github.io/fava/usage.html#filtering
//
// Tokens emitted:
//   tag         → "#tag-name"
//   link        → "^link-name"
//   payee       → 'payee:"value"' (or bare if no special chars)
//   account     → 'account:"path"' for *additional* accounts beyond the
//                 primary (which goes to URL `account=` server-side)
//   excludeAcc  → '-account:"path"'
//   text        → bare token or quoted phrase
//
// Multiple terms space-separated AND together server-side.

import type { SearchQuery } from "./parse"

/**
 * Build a fava `filter=` string from a parsed SearchQuery. The primary
 * account (the one already going to URL `account=`) is dropped so we
 * don't double-restrict. Returns undefined when nothing would be emitted.
 */
export function toFavaFilter(
  q: SearchQuery,
  primaryAccount?: string
): string | undefined {
  const parts: string[] = []
  for (const a of q.accounts) {
    if (a === primaryAccount) continue
    parts.push(`account:${quoteIfNeeded(a)}`)
  }
  for (const a of q.excludeAccounts) {
    parts.push(`-account:${quoteIfNeeded(a)}`)
  }
  for (const t of q.tags) parts.push(`#${t}`)
  for (const l of q.links) parts.push(`^${l}`)
  for (const p of q.payees) parts.push(`payee:${quoteIfNeeded(p)}`)
  for (const t of q.text) parts.push(quoteIfNeeded(t))
  return parts.length ? parts.join(" ") : undefined
}

/**
 * Quote a value when it contains whitespace or any fava filter-syntax
 * sigil (`"`, `#`, `^`, `:`, `|`, parens, `-`). Escapes embedded quotes.
 * Conservative — quoting an unnecessary value is harmless.
 */
function quoteIfNeeded(s: string): string {
  if (/[\s"#^|():-]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return s
}
