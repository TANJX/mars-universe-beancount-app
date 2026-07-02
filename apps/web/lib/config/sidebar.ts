import type { UIConfigWire } from "./schema"
import type { Bookmark, SidebarConfig } from "./types"

export const SIDEBAR_DEFAULTS: SidebarConfig = {
  bookmarks: [],
}

export function resolveSidebar(user: UIConfigWire["sidebar"]): SidebarConfig {
  if (!user) return SIDEBAR_DEFAULTS
  return {
    bookmarks: (user.bookmarks ?? SIDEBAR_DEFAULTS.bookmarks) as Bookmark[],
  }
}
