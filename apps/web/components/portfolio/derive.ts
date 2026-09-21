// Client-side derivations for the Portfolio page.
//
// Allocation is folded here rather than sent by the endpoint: every grouping
// is a re-fold of `sleeves[].holdings`, so shipping three more arrays would
// only create ways for the allocation card and the positions table to
// disagree.
//
// Nothing in this file knows a ticker, an account path, a broker or an asset
// class by name. Labels arrive in the payload or come from `ui.yaml` via
// `assetClassLabel`.

import type { InvestmentsConfig } from "@/lib/config"
import { assetClassLabel } from "@/lib/config"
import { parseLocalDate } from "@/lib/fava/periods"
import type { Portfolio, PortfolioSleeve } from "@/lib/fava/schemas"

/**
 * The one asset-class slug the app names. Uninvested sleeve cash has no
 * commodity and therefore no `asset-class:` metadata, but it is not a
 * separate asset class either: it belongs with the short-term bucket. The
 * *label* still comes from `investments.asset_class_labels`, so the string a
 * reader sees is config, not code.
 */
const CASH_ASSET_CLASS = "cash-short"

// ─── sleeves ──────────────────────────────────────────────────────────────

export interface SleeveView {
  sleeve: PortfolioSleeve
  /** Securities only: cash is not a gain or a loss. */
  gain: number
  gainPct: number
  /** Share of whole-portfolio market value, in percent. */
  weight: number
}

export function sleeveViews(p: Portfolio): SleeveView[] {
  const total = p.totals.value
  return (
    p.sleeves
      // Closed positions are hidden, so a sleeve holding nothing but history has
      // nothing left to show. A sleeve with only cash still does.
      .filter((s) => s.holdings.length > 0 || s.cash !== 0)
      .map((sleeve) => {
        const gain = sleeve.securitiesValue - sleeve.securitiesCost
        return {
          sleeve,
          gain,
          gainPct: sleeve.securitiesCost
            ? (gain / sleeve.securitiesCost) * 100
            : 0,
          weight: total ? (sleeve.value / total) * 100 : 0,
        }
      })
  )
}

/**
 * Reference width for the weight bars. Sleeve and holding weights share one
 * scale — both are a share of the whole portfolio — so the widest sleeve sets
 * the reference. Falls back to 100 so an empty portfolio cannot divide by
 * zero or read `-Infinity` from `Math.max()`.
 */
export function topWeightOf(views: SleeveView[]): number {
  const top = views.reduce((a, v) => Math.max(a, v.weight), 0)
  return top > 0 ? top : 100
}

// ─── allocation ───────────────────────────────────────────────────────────

export interface ShareRow {
  key: string
  label: string
  value: number
  share: number
}

function shares(rows: Omit<ShareRow, "share">[]): ShareRow[] {
  const total = rows.reduce((a, r) => a + r.value, 0)
  return rows
    .filter((r) => r.value !== 0)
    .map((r) => ({ ...r, share: total ? (r.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value)
}

/**
 * Whole-portfolio weights by asset class. Positive sleeve cash folds into the
 * short-term bucket; negative cash is a drawn margin allowance, not an asset
 * class, so it is left out entirely.
 */
export function byAssetClass(p: Portfolio, cfg: InvestmentsConfig): ShareRow[] {
  const acc = new Map<string, number>()
  const add = (key: string, value: number) =>
    acc.set(key, (acc.get(key) ?? 0) + value)

  for (const s of p.sleeves) {
    for (const h of s.holdings) {
      if (h.units <= 0) continue
      // "" is the unclassified bucket: a commodity with no `asset-class:`
      // metadata groups on its own rather than joining one it does not
      // belong to.
      add(h.assetClass ?? "", h.value)
    }
    if (s.cash > 0) add(CASH_ASSET_CLASS, s.cash)
  }

  return shares(
    [...acc.entries()].map(([key, value]) => ({
      key: key || "__unclassified",
      label: assetClassLabel(cfg, key || null),
      value,
    }))
  )
}

/** Whole-portfolio weights by ticker. The long tail folds into "N others". */
export function byTicker(p: Portfolio): ShareRow[] {
  const acc = new Map<string, number>()
  for (const s of p.sleeves) {
    for (const h of s.holdings) {
      if (h.units <= 0) continue
      acc.set(h.ticker, (acc.get(h.ticker) ?? 0) + h.value)
    }
  }
  return shares(
    [...acc.entries()].map(([key, value]) => ({ key, label: key, value }))
  )
}

export function bySleeve(p: Portfolio): ShareRow[] {
  return shares(
    p.sleeves.map((s) => ({ key: s.id, label: s.label, value: s.value }))
  )
}

// ─── contribution pace ────────────────────────────────────────────────────

/**
 * Fraction of the calendar year elapsed at `asof` — the pace reference the
 * contribution meters mark. Leap years fall out of the arithmetic because the
 * denominator is the real distance between the two January firsts.
 */
export function yearElapsed(asof: string): number {
  const d = parseLocalDate(asof)
  const year = d.getFullYear()
  const start = new Date(year, 0, 1).getTime()
  const end = new Date(year + 1, 0, 1).getTime()
  const f = (d.getTime() - start) / (end - start)
  return Math.min(1, Math.max(0, f))
}

/** Calendar year of the as-of date, for the contribution card's heading. */
export function asofYear(asof: string): number {
  return parseLocalDate(asof).getFullYear()
}
