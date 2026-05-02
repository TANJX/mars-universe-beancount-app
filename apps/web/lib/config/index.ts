// Per-section config layer for the web app.
//
// Wire shape (parsed by ./schema) → resolver (this file) → consumer.
// Adding a new config section: add a section file (defaults + resolver),
// add it to the schema, and add one line below.

"use client"

import * as React from "react"

import { resolveAccounts } from "./accounts"
import { resolveBranding } from "./branding"
import { resolveMerchants } from "./merchants"
import { resolveSidebar } from "./sidebar"
import type { ResolvedUI } from "./types"
import { useUIConfig } from "./use-ui-config"

export const RESOLVED_DEFAULTS: ResolvedUI = {
  branding: resolveBranding(undefined),
  accounts: resolveAccounts(undefined),
  merchants: resolveMerchants(undefined),
  sidebar: resolveSidebar(undefined),
}

/** Merged user config + bundled defaults. Returns defaults until the
 * fetch resolves; never throws. */
export function useResolvedUIConfig(): ResolvedUI {
  const { data } = useUIConfig()
  return React.useMemo(() => {
    if (!data) return RESOLVED_DEFAULTS
    return {
      branding: resolveBranding(data.branding),
      accounts: resolveAccounts(data.accounts),
      merchants: resolveMerchants(data.merchants),
      sidebar: resolveSidebar(data.sidebar),
    }
  }, [data])
}

// Re-export the underlying hook so consumers can read loading state without
// duplicating import paths. React Query dedupes by queryKey, so calling both
// `useResolvedUIConfig()` and `useUIConfig()` in the same component is cheap.
export { useUIConfig } from "./use-ui-config"

export type {
  ResolvedUI,
  Branding,
  AccountsConfig,
  MerchantEntry,
  MerchantRegistry,
  Bookmark,
  SidebarConfig,
} from "./types"
