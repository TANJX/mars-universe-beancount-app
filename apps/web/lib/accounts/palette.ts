// Account-color and rollup helpers.
//
// Bundled defaults are empty — the app ships neutral. User overrides live
// in `<LEDGER_DIR>/config/ui.yaml > accounts.colors` / `accounts.category_rollup`
// and are consumed via the hooks below in React components. The pure
// fallbacks (`lookupCategoryColor`, `rollupKey`) are no-ops; non-React
// callers can safely use them and get the same shape (just no overrides).

"use client"

import * as React from "react"

import type { AccountPath } from "@/lib/types/beancount"
import { useResolvedUIConfig } from "@/lib/config"
import { lookupColor, rollupKey as rollupKeyImpl } from "@/lib/config/accounts"

/** Pure no-op — undefined unless a config-aware caller is used. */
export function lookupCategoryColor(_path: AccountPath): string | undefined {
  return undefined
}

/** Pure passthrough — consumers without config see no rollup. */
export function rollupKey(path: AccountPath): AccountPath {
  return path
}

/** Hook returning a config-aware color lookup. */
export function useLookupCategoryColor(): (
  path: AccountPath
) => string | undefined {
  const ui = useResolvedUIConfig()
  return React.useCallback(
    (path: AccountPath) => lookupColor(ui.accounts, path),
    [ui.accounts]
  )
}

/** Hook returning a config-aware rollup mapping. */
export function useRollupKey(): (path: AccountPath) => AccountPath {
  const ui = useResolvedUIConfig()
  return React.useCallback(
    (path: AccountPath) => rollupKeyImpl(ui.accounts, path),
    [ui.accounts]
  )
}
