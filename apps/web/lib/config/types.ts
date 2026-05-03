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

// ── Resolved (merged user + defaults) ────────────────────────────────────
export interface ResolvedUI {
  branding: Branding
  accounts: AccountsConfig
  merchants: MerchantRegistry
  sidebar: SidebarConfig
}
