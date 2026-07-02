// Six-stage merchant resolver. Returns one of three render shapes:
//   - logo:    a logo.dev URL with a fallback letter mark baked in
//   - glyph:   a class- or category-driven lucide icon
//   - initial: a derived letter mark (registry hit or generic fallback)
//
// Stage order — first match wins:
//   1.   Class override (transfer/investment/rebate/pending/forecast)
//   2.   Account override (Income:Salary:Acme → Acme via accounts.logos)
//   3.   Payee patterns → registry (Tm *, ACH Des:…)
//   4.   Cleaned payee → registry (exact then longest-substring on name|aliases)
//   4.5. Category icon (Expenses:Restaurants → utensils via accounts.categoryIcons)
//   5.   Auto-derived letter mark (initial + hash color from payee/narration)

import {
  lookupAccountCategoryIcon,
  lookupAccountLogo,
  lookupDisplayName,
} from "@/lib/config/accounts"
import type {
  AccountsConfig,
  MerchantEntry,
  MerchantRegistry,
} from "@/lib/config/types"
import type { Posting } from "@/lib/types/beancount"
import type { JournalRow } from "@/lib/types/views"
import { type AvatarFallback, deriveFallback } from "./avatar-fallback"
import { GLYPHS, type GlyphSpec, type GlyphTone } from "./glyphs"
import { logoDevUrl } from "./logodev"
import { matchMerchant } from "./match"

export type Resolved =
  | { kind: "logo"; src: string; alt: string; fallback: AvatarFallback }
  | { kind: "glyph"; glyph: GlyphSpec; alt: string }
  | { kind: "category-icon"; name: string; tone: GlyphTone; alt: string }
  | { kind: "initial"; entry: AvatarFallback; alt: string }

export interface ResolveContext {
  /** Logical row context. Provides class + posting accounts for stages 1-2. */
  row?: JournalRow
  /** Raw payee string. Used by stages 3-5 when row context isn't available. */
  payee?: string
  /** Pixel size of the rendered avatar — passes through to logo.dev for sizing. */
  size?: number
  /** Merged merchant registry (defaults + user `merchants:`). */
  registry: MerchantRegistry
  /** Resolved accounts config (drives stage 2's account → merchant lookup). */
  accounts: AccountsConfig
}

/** True when the *primary* posting is in a "money in flight" subtree —
 * meaning the transaction's user-facing perspective is the holding account
 * itself, not a brand. Split expenses also touch these subtrees on a side
 * leg, but their primary is still the merchant payment, so they're not
 * caught here.
 *
 * `Liabilities:Payable` is intentionally excluded: a Payable-funded expense
 * (e.g. rent billed → Expenses:Home:Rent + Liabilities:Payable:Rent) is a
 * real merchant transaction. Paying down a payable is classified as a
 * transfer; primary lands on the funding card, not the payable. Either way
 * the hourglass would mis-fire. */
function isPendingPrimary(primary: Posting | null): boolean {
  if (!primary) return false
  return (
    primary.account.startsWith("Assets:Pending-Transfer") ||
    primary.account.startsWith("Assets:Transit")
  )
}

export function resolveMerchant(ctx: ResolveContext): Resolved {
  const size = ctx.size ?? 28
  const payee = (ctx.payee ?? ctx.row?.txn.payee ?? "").trim()
  const { registry, accounts } = ctx

  // ── Stage 1: class glyphs ──────────────────────────────────────────────
  if (ctx.row) {
    const { row } = ctx
    if (row.isForecast) {
      return { kind: "glyph", glyph: GLYPHS.forecast, alt: "Forecast" }
    }
    if (row.class === "transfer") {
      return { kind: "glyph", glyph: GLYPHS.transfer, alt: "Transfer" }
    }
    if (row.class === "investment") {
      return { kind: "glyph", glyph: GLYPHS.investment, alt: "Investment" }
    }
    if (row.class === "rebate") {
      return { kind: "glyph", glyph: GLYPHS.rebate, alt: "Rebate" }
    }
    // Genuine "money in flight" rows: ATM withdrawals waiting to clear,
    // funds in transit.
    if (isPendingPrimary(row.primary)) {
      return { kind: "glyph", glyph: GLYPHS.pending, alt: "Pending" }
    }
  }

  // ── Stage 2: account override (income/category-driven) ─────────────────
  // For income, the bank-side payee is usually generic ("Direct Deposit
  // Inc.") so the *category* account is the brand. For non-income, only
  // the category leg drives the brand — funding postings (a credit card
  // account) overriding the payee produces "everything is Bilt" drift.
  if (ctx.row) {
    const isIncome = ctx.row.class === "income"
    if (isIncome) {
      for (const p of ctx.row.txn.postings) {
        const name = lookupAccountLogo(accounts, p.account)
        if (name && registry[name]) return renderEntry(registry[name], size)
      }
    } else if (ctx.row.category) {
      const name = lookupAccountLogo(accounts, ctx.row.category.account)
      if (name && registry[name]) {
        // Payee wins if it produces a registry hit; otherwise account
        // override fires.
        const payeeHit = matchMerchant(payee || null, registry)
        if (!payeeHit) return renderEntry(registry[name], size)
      }
    }
  }

  // ── Stage 3-4: payee → registry ────────────────────────────────────────
  const entry = matchMerchant(payee || null, registry)
  if (entry) return renderEntry(entry, size)

  // ── Stage 4.5: category icon ───────────────────────────────────────────
  // When payee resolution misses, the category posting still carries
  // signal: an unrecognized payee in `Expenses:Restaurants` is meaningfully
  // a restaurant. Same posting-source rule as `accounts.logos`: scan all
  // postings for income, category leg only for non-income. The icon name
  // is rendered via lucide-react/dynamic — no allowlist, any valid lucide
  // kebab-case name works.
  if (ctx.row) {
    const isIncome = ctx.row.class === "income"
    const candidates: Posting[] = isIncome
      ? ctx.row.txn.postings
      : ctx.row.category
        ? [ctx.row.category]
        : []
    for (const p of candidates) {
      const iconName = lookupAccountCategoryIcon(accounts, p.account)
      if (!iconName) continue
      const label =
        lookupDisplayName(accounts, p.account) ?? leafSegment(p.account)
      return {
        kind: "category-icon",
        name: iconName,
        tone: "muted",
        alt: label,
      }
    }
  }

  // ── Stage 5: auto-derived letter-mark fallback ─────────────────────────
  return {
    kind: "initial",
    entry: deriveFallback(payee || ctx.row?.txn.narration || null),
    alt: payee || "Transaction",
  }
}

function leafSegment(account: string): string {
  const i = account.lastIndexOf(":")
  return i < 0 ? account : account.slice(i + 1)
}

function renderEntry(entry: MerchantEntry, size: number): Resolved {
  const fallback = deriveFallback(entry.name)
  if (entry.domain) {
    const src = logoDevUrl(entry.domain, size)
    if (src) {
      return { kind: "logo", src, alt: entry.name, fallback }
    }
  }
  return { kind: "initial", entry: fallback, alt: entry.name }
}
