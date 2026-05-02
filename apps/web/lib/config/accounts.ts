// Defaults + resolver for the `accounts:` section of ui.yaml.
// Bundled defaults are intentionally empty — the app should render fine
// with no user config. Users add their own preferences in ui.yaml.

import type { AccountPath } from "@/lib/types/beancount"

import type { AccountsConfig } from "./types"
import type { UIConfigWire } from "./schema"

export const ACCOUNTS_DEFAULTS: AccountsConfig = {
  displayNames: {},
  logos: {},
  colors: {},
  categoryRollup: [],
}

export function resolveAccounts(
  user: UIConfigWire["accounts"]
): AccountsConfig {
  if (!user) return ACCOUNTS_DEFAULTS
  return {
    displayNames: {
      ...ACCOUNTS_DEFAULTS.displayNames,
      ...(user.display_names ?? {}),
    },
    logos: { ...ACCOUNTS_DEFAULTS.logos, ...(user.logos ?? {}) },
    colors: { ...ACCOUNTS_DEFAULTS.colors, ...(user.colors ?? {}) },
    categoryRollup:
      user.category_rollup && user.category_rollup.length > 0
        ? (user.category_rollup as AccountPath[])
        : ACCOUNTS_DEFAULTS.categoryRollup,
  }
}

// ── Pure lookup helpers (consume an AccountsConfig — no React) ───────────

/** Resolve display label for an account path; falls back to the leaf segment. */
export function lookupDisplayName(
  cfg: AccountsConfig,
  path: AccountPath
): string | undefined {
  return cfg.displayNames[path]
}

/** Walk ancestors to find a hand-picked color. */
export function lookupColor(
  cfg: AccountsConfig,
  path: AccountPath
): string | undefined {
  let cur: string = path
  while (cur.length > 0) {
    if (cur in cfg.colors) return cfg.colors[cur]
    const i = cur.lastIndexOf(":")
    if (i < 0) break
    cur = cur.slice(0, i)
  }
  return undefined
}

/** Map a leaf path to its rollup bucket prefix, or itself if no rollup. */
export function rollupKey(cfg: AccountsConfig, path: AccountPath): AccountPath {
  for (const prefix of cfg.categoryRollup) {
    if (path === prefix || path.startsWith(prefix + ":")) return prefix
  }
  return path
}

/** Deepest-prefix match for the account → merchant override table. */
export function lookupAccountLogo(
  cfg: AccountsConfig,
  path: AccountPath
): string | null {
  if (cfg.logos[path]) return cfg.logos[path]
  let cur = path
  while (cur.includes(":")) {
    cur = cur.slice(0, cur.lastIndexOf(":"))
    const hit = cfg.logos[cur]
    if (hit) return hit
  }
  return null
}
