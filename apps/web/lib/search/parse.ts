// Search-string parser used by both the page-local search bars (Expenses,
// Journal) and the global ⌘K palette. Tokens:
//
//   account:<path>          — hierarchical match (Expenses:Restaurants
//                             matches Expenses:Restaurants:*)
//   exclude:account:<path>  — negative match
//   payee:<text>            — substring on payee
//   tag:<text>              — exact tag (case-insensitive)
//   link:<text>             — exact link (case-insensitive)
//   "quoted text"           — phrase match in payee/narration/category
//   bare text               — same as a quoted phrase, but tokenised on
//                             whitespace
//
// The parser is permissive: anything that doesn't fit a known prefix becomes
// a bare term. Empty input → an empty SearchQuery (matches everything).

import { accountMatches, accountRoot } from "@/lib/transform/classify"
import type { Transaction } from "@/lib/types/beancount"

export interface SearchQuery {
  /** Hierarchical account filters. Multiple are AND'd. */
  accounts: string[]
  /** Hierarchical account exclusions. */
  excludeAccounts: string[]
  payees: string[]
  tags: string[]
  links: string[]
  /** Quoted phrases or bare tokens — matched anywhere. */
  text: string[]
}

function emptyQuery(): SearchQuery {
  return {
    accounts: [],
    excludeAccounts: [],
    payees: [],
    tags: [],
    links: [],
    text: [],
  }
}

export function parseSearch(input: string): SearchQuery {
  if (!input.trim()) return emptyQuery()
  const out: SearchQuery = emptyQuery()
  // Regex tokenises into: prefix:value, "quoted text", or bare-word
  const tokenRe =
    /(-?(?:exclude:account|account|payee|tag|link):[^\s]+)|"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((m = tokenRe.exec(input))) {
    const prefixed = m[1]
    const phrase = m[2]
    const bare = m[3]
    if (prefixed) {
      const colon = prefixed.indexOf(":")
      const head = prefixed.slice(0, colon)
      const value = prefixed.slice(colon + 1)
      if (head === "account") out.accounts.push(value)
      else if (head === "exclude:account" || head === "-account")
        out.excludeAccounts.push(value)
      else if (head === "payee") out.payees.push(value)
      else if (head === "tag") out.tags.push(value)
      else if (head === "link") out.links.push(value)
    } else if (phrase) {
      out.text.push(phrase)
    } else if (bare) {
      // bare may be `key:value` we didn't match — treat as text
      out.text.push(bare)
    }
  }
  return out
}

/**
 * Render a SearchQuery back to its canonical input form. Used for chip-edit
 * round-tripping and for shareable URLs.
 */
export function stringifySearch(q: SearchQuery): string {
  const parts: string[] = []
  for (const a of q.accounts) parts.push(`account:${a}`)
  for (const a of q.excludeAccounts) parts.push(`exclude:account:${a}`)
  for (const p of q.payees) parts.push(`payee:${p}`)
  for (const t of q.tags) parts.push(`tag:${t}`)
  for (const l of q.links) parts.push(`link:${l}`)
  for (const t of q.text) parts.push(t.includes(" ") ? `"${t}"` : t)
  return parts.join(" ")
}

export function isQueryEmpty(q: SearchQuery): boolean {
  return (
    q.accounts.length === 0 &&
    q.excludeAccounts.length === 0 &&
    q.payees.length === 0 &&
    q.tags.length === 0 &&
    q.links.length === 0 &&
    q.text.length === 0
  )
}

/**
 * Apply a parsed search to a list of transactions, client-side. Account
 * filters use the same hierarchical match as Fava's `account=`. Other terms
 * are case-insensitive substring matches.
 */
export function applySearch(
  txns: Transaction[],
  q: SearchQuery
): Transaction[] {
  if (isQueryEmpty(q)) return txns
  const lcText = q.text.map((t) => t.toLowerCase())
  const lcPayees = q.payees.map((t) => t.toLowerCase())
  const lcTags = new Set(q.tags.map((t) => t.toLowerCase()))
  const lcLinks = new Set(q.links.map((l) => l.toLowerCase()))

  return txns.filter((t) => {
    if (q.accounts.length) {
      const ok = q.accounts.every((acc) =>
        t.postings.some((p) => accountMatches(p.account, acc))
      )
      if (!ok) return false
    }
    if (q.excludeAccounts.length) {
      const bad = q.excludeAccounts.some((acc) =>
        t.postings.some((p) => accountMatches(p.account, acc))
      )
      if (bad) return false
    }
    if (lcPayees.length) {
      const lp = t.payee.toLowerCase()
      if (!lcPayees.every((p) => lp.includes(p))) return false
    }
    if (lcTags.size) {
      const txTags = new Set(t.tags.map((x) => x.toLowerCase()))
      for (const tag of lcTags) if (!txTags.has(tag)) return false
    }
    if (lcLinks.size) {
      const txLinks = new Set(t.links.map((x) => x.toLowerCase()))
      for (const lnk of lcLinks) if (!txLinks.has(lnk)) return false
    }
    if (lcText.length) {
      const hay = (
        t.payee +
        " " +
        t.narration +
        " " +
        t.postings.map((p) => p.account).join(" ") +
        " " +
        t.tags.join(" ") +
        " " +
        t.links.join(" ")
      ).toLowerCase()
      if (!lcText.every((needle) => hay.includes(needle))) return false
    }
    return true
  })
}

/**
 * Pick the *first* account filter (so server-side `account=` can take it).
 * If multiple are supplied, the rest are applied client-side.
 */
export function pickPrimaryAccount(q: SearchQuery): string | undefined {
  return q.accounts[0]
}

export type TokenKind =
  | "account"
  | "exclude:account"
  | "payee"
  | "tag"
  | "link"
  | "text"

export interface Token {
  kind: TokenKind
  value: string
}

const FIELD_BY_KIND: Record<TokenKind, keyof SearchQuery> = {
  account: "accounts",
  "exclude:account": "excludeAccounts",
  payee: "payees",
  tag: "tags",
  link: "links",
  text: "text",
}

function cloneQuery(q: SearchQuery): SearchQuery {
  return {
    accounts: q.accounts.slice(),
    excludeAccounts: q.excludeAccounts.slice(),
    payees: q.payees.slice(),
    tags: q.tags.slice(),
    links: q.links.slice(),
    text: q.text.slice(),
  }
}

/** Append a token to a SearchQuery and return a new query. */
export function addToken(q: SearchQuery, token: Token): SearchQuery {
  const next = cloneQuery(q)
  next[FIELD_BY_KIND[token.kind]].push(token.value)
  return next
}

/** True iff the SearchQuery already carries this exact token. */
export function hasToken(q: SearchQuery, token: Token): boolean {
  return q[FIELD_BY_KIND[token.kind]].includes(token.value)
}

/**
 * Remove the first matching token from a SearchQuery and return a new query.
 * Match is exact-string on value within the kind's field. If no match, returns
 * the original query unchanged.
 */
export function removeToken(q: SearchQuery, token: Token): SearchQuery {
  const field = FIELD_BY_KIND[token.kind]
  const idx = q[field].indexOf(token.value)
  if (idx === -1) return q
  const next = cloneQuery(q)
  next[field].splice(idx, 1)
  return next
}

// Re-export for callers that want the helper in one import.
export { accountRoot }
