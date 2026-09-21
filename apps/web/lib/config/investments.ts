// Defaults + resolver for the `investments:` section of ui.yaml.
//
// Everything here is annotation. The portfolio endpoint discovers sleeves by
// walking `Assets:Investment:*` and reads security names / asset classes from
// the ledger's `commodity` directives, so a ledger with no `investments:`
// block still renders the whole page — it just loses the tax chips, the
// contribution meters and the margin note.
//
// Nothing ledger-specific belongs in this file: no account paths, no broker
// names, no tickers. Those live in ui.yaml or the journal.

import type { AccountPath } from "@/lib/types/beancount"

import type { UIConfigWire } from "./schema"
import type {
  ContributionCadence,
  InvestmentsConfig,
  SleeveAnnotation,
  TaxTreatment,
} from "./types"
import { TAX_TREATMENTS } from "./types"

export const INVESTMENTS_DEFAULTS: InvestmentsConfig = {
  sleeves: {},
  limits: {},
  cadence: {},
  realized: { gains: null, dividends: null },
  assetClassLabels: {},
}

const TAX_SET: ReadonlySet<string> = new Set<string>(TAX_TREATMENTS)

/** Narrow a configured string to a known tax treatment; null if unrecognised. */
export function asTaxTreatment(value: unknown): TaxTreatment | null {
  return typeof value === "string" && TAX_SET.has(value)
    ? (value as TaxTreatment)
    : null
}

export function resolveInvestments(
  user: UIConfigWire["investments"]
): InvestmentsConfig {
  if (!user) return INVESTMENTS_DEFAULTS

  const sleeves: Record<AccountPath, SleeveAnnotation> = {}
  for (const s of user.sleeves ?? []) {
    if (!s?.account) continue
    sleeves[s.account] = {
      account: s.account,
      tax: asTaxTreatment(s.tax),
      limitKey: s.limit_key ?? null,
      marginFreeTranche:
        typeof s.margin_free_tranche === "number"
          ? s.margin_free_tranche
          : null,
    }
  }

  const limits: Record<string, Record<string, number>> = {}
  for (const [year, table] of Object.entries(user.limits ?? {})) {
    if (!table) continue
    limits[String(year)] = { ...table }
  }

  const cadence: Record<string, ContributionCadence> = {}
  for (const [key, entry] of Object.entries(user.cadence ?? {})) {
    if (!entry) continue
    cadence[key] = { amount: entry.amount, per: entry.per }
  }

  return {
    sleeves,
    limits,
    cadence,
    realized: {
      gains: user.realized?.gains ?? null,
      dividends: user.realized?.dividends ?? null,
    },
    assetClassLabels: {
      ...INVESTMENTS_DEFAULTS.assetClassLabels,
      ...(user.asset_class_labels ?? {}),
    },
  }
}

// ── Pure lookup helpers (consume an InvestmentsConfig — no React) ────────

/**
 * Deepest-prefix match for the sleeve annotation table, so an entry on a
 * parent covers its subtree (a `…:Roth-IRA` entry also answers for the
 * `…:Roth-IRA:USD` cash leaf).
 */
export function lookupSleeveAnnotation(
  cfg: InvestmentsConfig,
  path: AccountPath
): SleeveAnnotation | null {
  if (cfg.sleeves[path]) return cfg.sleeves[path]
  let cur = path
  while (cur.includes(":")) {
    cur = cur.slice(0, cur.lastIndexOf(":"))
    const hit = cfg.sleeves[cur]
    if (hit) return hit
  }
  return null
}

/** Annual ceiling for a contribution bucket in a given year, if configured. */
export function lookupContributionLimit(
  cfg: InvestmentsConfig,
  year: number | string,
  limitKey: string
): number | null {
  return cfg.limits[String(year)]?.[limitKey] ?? null
}

/** Funding cadence for a contribution bucket, if configured. */
export function lookupCadence(
  cfg: InvestmentsConfig,
  limitKey: string
): ContributionCadence | null {
  return cfg.cadence[limitKey] ?? null
}

/**
 * Display label for an asset-class slug. Falls back to de-slugifying the
 * value, and to "Unclassified" for a commodity with no `asset-class:`
 * metadata — never to a bundled table of fund categories, which would make
 * this repo carry market data it has no way to keep current.
 */
export function assetClassLabel(
  cfg: InvestmentsConfig,
  slug: string | null | undefined
): string {
  if (!slug) return "Unclassified"
  const configured = cfg.assetClassLabels[slug]
  if (configured) return configured
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}
