// Shared types for the user UI config layer. Each section file imports the
// pieces it needs; consumers go through `useResolvedUIConfig()`.

import type { AccountPath } from "@/lib/types/beancount"
import type { AccountRoot } from "@/lib/types/views"

// ── Branding ─────────────────────────────────────────────────────────────
export interface Branding {
  title: string
  subtitle: string
}

// ── Accounts ─────────────────────────────────────────────────────────────
export interface AccountsConfig {
  /** Account-path → human-readable label override. */
  displayNames: Record<AccountPath, string>
  /** Account-path → merchant name (Stage 2 of the logo resolver). */
  logos: Record<AccountPath, string>
  /** Account-path → oklch color (ancestor walk). */
  colors: Record<AccountPath, string>
  /** Account-path → lucide icon name (Stage 4.5 of the logo resolver,
   * ancestor walk). Bundled defaults merged with user `category_icons`. */
  categoryIcons: Record<AccountPath, string>
  /** Subtree prefixes whose descendants collapse to a single bucket in charts. */
  categoryRollup: AccountPath[]
}

// ── Merchants ────────────────────────────────────────────────────────────
/**
 * Canonical merchant entry. The `name` field is the human-readable brand
 * name AND the lookup key — no separate id/displayName. The render layer
 * derives a letter-mark fallback (initial + colored swatch) from the name.
 */
export interface MerchantEntry {
  name: string
  /** Domain handed to logo.dev (e.g. "apple.com"). Omit for niche brands —
   * they render as a letter mark. */
  domain?: string
  /** Extra payee tokens (case-insensitive) that should resolve to this merchant.
   * Covers ACH wire tokens, alternative spellings, abbreviations, etc. */
  aliases?: string[]
}

/** Map keyed by canonical merchant name. */
export type MerchantRegistry = Record<string, MerchantEntry>

// ── Sidebar ──────────────────────────────────────────────────────────────
export interface Bookmark {
  id: string
  label: string
  root: AccountRoot
  accountPath: AccountPath
}

export interface SidebarConfig {
  bookmarks: Bookmark[]
}

// ── Investments ──────────────────────────────────────────────────────────
/**
 * Tax treatment of a sleeve. A closed vocabulary because the page renders one
 * chip per value; the *accounts* carrying each treatment are user config, so
 * no ledger-specific path ever needs to appear here.
 */
export const TAX_TREATMENTS = [
  "roth",
  "traditional",
  "hsa",
  "taxable",
  "401k",
  "roth-401k",
] as const

export type TaxTreatment = (typeof TAX_TREATMENTS)[number]

/**
 * Annotation for one investment sleeve. Sleeves are *discovered* server-side
 * by walking `Assets:Investment:*` — this only decorates them, so a sleeve
 * missing from config still renders, just without a tax chip or a meter.
 */
export interface SleeveAnnotation {
  account: AccountPath
  /** Null when unset or when the configured value is not a known treatment. */
  tax: TaxTreatment | null
  /** Contribution bucket this sleeve counts against (e.g. two IRAs sharing
   * one annual ceiling). Keys the `limits` and `cadence` maps below. */
  limitKey: string | null
  /** Interest-free margin allowance the broker grants, in USD. A cash balance
   * down to −`marginFreeTranche` is the allowance in use, not debt. */
  marginFreeTranche: number | null
}

/** Recurring funding, used for the "maxes out by …" projection. */
export interface ContributionCadence {
  amount: number
  /** Cadence unit as written in config ("week", "month", …). */
  per: string
}

/** Ledger-specific income accounts the realized panel reads. */
export interface RealizedAccounts {
  gains: AccountPath | null
  dividends: AccountPath | null
}

export interface InvestmentsConfig {
  /** Account path → annotation. Lookup walks ancestors, so an entry on a
   * parent covers its whole subtree. */
  sleeves: Record<AccountPath, SleeveAnnotation>
  /** Calendar year (as a string) → limit key → annual ceiling. Keyed by year
   * because contribution limits change annually and history must stay right. */
  limits: Record<string, Record<string, number>>
  /** Limit key → funding cadence. */
  cadence: Record<string, ContributionCadence>
  realized: RealizedAccounts
  /** Asset-class slug → display label. The slugs come from the ledger's
   * `commodity` directives, so the vocabulary is not fixed in app code. */
  assetClassLabels: Record<string, string>
}

// ── Resolved (merged user + defaults) ────────────────────────────────────
export interface ResolvedUI {
  branding: Branding
  accounts: AccountsConfig
  merchants: MerchantRegistry
  sidebar: SidebarConfig
  investments: InvestmentsConfig
}
