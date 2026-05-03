// Bundled-default category → icon mappings. Aligned with the canonical
// expense / income taxonomy (see `docs/notes/accounts.md` in the ledger
// repo). Non-standard account paths belong in user
// `ui.yaml > accounts.category_icons`.
//
// Values are lucide icon names — must exist in CATEGORY_ICONS in
// `merchants/glyphs.ts`. Lookup walks ancestors, so an entry on a parent
// (e.g. "Expenses:Home") applies to the whole subtree unless a deeper
// match overrides (`Expenses:Home:Utilities` → `zap`).

export const CATEGORY_ICON_DEFAULTS: Record<string, string> = {
  // ── Expenses: top-level / single-segment ────────────────────────────────
  "Expenses:Restaurants": "utensils",
  "Expenses:Groceries": "shopping-cart",
  "Expenses:Subscription": "tv",
  "Expenses:Health": "stethoscope",
  "Expenses:Car": "car",
  "Expenses:Fee": "receipt",
  "Expenses:Government": "landmark",
  "Expenses:Interest": "percent",

  // ── Expenses:Home ────────────────────────────────────────────────────────
  "Expenses:Home": "home",
  "Expenses:Home:Utilities": "zap",

  // ── Expenses:Transportation ─────────────────────────────────────────────
  "Expenses:Transportation": "car",
  "Expenses:Transportation:Public": "bus",
  "Expenses:Transportation:Driving": "fuel",

  // ── Expenses:Travel ─────────────────────────────────────────────────────
  "Expenses:Travel": "plane",
  "Expenses:Travel:Hotel": "bed-double",
  "Expenses:Travel:Car-Rental": "car",
  "Expenses:Travel:Ticket": "ticket",

  // ── Expenses:Purchases ──────────────────────────────────────────────────
  "Expenses:Purchases": "shopping-bag",
  "Expenses:Purchases:Clothes": "shirt",
  "Expenses:Purchases:Electronic": "cpu",
  "Expenses:Purchases:Gift": "gift",

  // ── Expenses:Leisure ────────────────────────────────────────────────────
  "Expenses:Leisure": "tv",
  "Expenses:Leisure:Cinema": "film",
  "Expenses:Leisure:Concert": "music",
  "Expenses:Leisure:Arcade": "gamepad-2",
  "Expenses:Leisure:Conference": "presentation",

  // ── Expenses:Family ─────────────────────────────────────────────────────
  "Expenses:Family": "users",
  "Expenses:Family:Restaurant": "utensils",
  "Expenses:Family:Groceries": "shopping-cart",
  "Expenses:Family:Flight": "plane",
  "Expenses:Family:Hotel": "bed-double",
  "Expenses:Family:Cab": "car",
  "Expenses:Family:Shopping": "shopping-bag",

  // ── Income ──────────────────────────────────────────────────────────────
  "Income:Salary": "wallet",
  "Income:Salary:Freelance": "briefcase",
  "Income:Interest": "coins",
  "Income:Rebate": "coins",
  "Income:Trading": "trending-up",
  "Income:Trading:Dividend": "coins",
  "Income:Sale": "tag",
  "Income:Tax": "landmark",
  "Income:Currency-Exchange": "arrow-left-right",
}
