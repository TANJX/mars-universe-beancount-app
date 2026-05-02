// Display-name resolution for account paths.
//
// The pure function `displayAccount(path)` falls back to the leaf segment
// — no bundled overrides; the app ships neutral. User overrides live in
// `<LEDGER_DIR>/config/ui.yaml > accounts.display_names` and are consumed
// via the `useDisplayAccount()` hook in React components.

"use client"

import * as React from "react"

import type { AccountPath } from "@/lib/types/beancount"
import { useResolvedUIConfig } from "@/lib/config"
import { lookupDisplayName } from "@/lib/config/accounts"
import { accountSegment } from "@/lib/transform/classify"

/** Pure, config-free fallback. Returns the leaf segment of the path. */
export function displayAccount(path: AccountPath): string {
  return accountSegment(path)
}

/** Hook returning a config-aware display-name lookup. */
export function useDisplayAccount(): (path: AccountPath) => string {
  const ui = useResolvedUIConfig()
  return React.useCallback(
    (path: AccountPath) =>
      lookupDisplayName(ui.accounts, path) ?? accountSegment(path),
    [ui.accounts]
  )
}
