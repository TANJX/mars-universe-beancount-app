// PROTOTYPE FIXTURE — delete with the rest of app/(ledger)/proto/.
//
// Synthetic. Structurally faithful to a real multi-sleeve ledger (tax
// treatments, per-sleeve targets, a margin tranche, stale prices, closed
// positions, 40+ tickers) but the amounts are invented, so nothing private
// lands in this repo. Proportions between sleeves are preserved, which is
// what the layout judgment actually depends on.
//
// Deliberate "worst content" packed in:
//   · 42 tickers, so allocation-by-ticker cannot fold into 8 hues
//   · fund names long enough to force truncation
//   · 6-decimal fractional units next to whole-share positions
//   · one sleeve exactly on target, one drifted past the ±5pp threshold
//   · negative brokerage cash that is NOT debt (interest-free margin)
//   · prices 13 days stale
//   · 5 closed positions that carry real meaning (deliberately sold overlaps)

export type TaxTreatment = "roth" | "traditional" | "hsa" | "taxable" | "401k"

export type AssetClass =
  | "us-large"
  | "us-small"
  | "intl-dev"
  | "emerging"
  | "single-stock"
  | "crypto"
  | "cash-short"

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  "us-large": "US large-cap core",
  "us-small": "US small-cap",
  "intl-dev": "Developed intl",
  emerging: "Emerging markets",
  "single-stock": "Single stocks",
  crypto: "Crypto",
  "cash-short": "Cash & short-term",
}

export interface Holding {
  ticker: string
  name: string
  assetClass: AssetClass
  units: number
  price: number
  cost: number
  value: number
}

export interface Sleeve {
  id: string
  account: string
  label: string
  tax: TaxTreatment
  /** Uninvested USD. Negative = margin drawn. */
  cash: number
  /** Interest-free margin allowance, if the broker grants one. */
  marginFreeTranche?: number
  /** Percent targets by ticker. Absent = no policy for this sleeve. */
  targets?: Record<string, number>
  limitKey?: "ira" | "hsa"
  holdings: Holding[]
}

export const ASOF = "2026-08-17"
export const PRICE_ASOF = "2026-08-04"

/** Build a holding from units + price + average cost per unit. */
function h(
  ticker: string,
  name: string,
  assetClass: AssetClass,
  units: number,
  price: number,
  costPerUnit: number
): Holding {
  return {
    ticker,
    name,
    assetClass,
    units,
    price,
    cost: units * costPerUnit,
    value: units * price,
  }
}

export const SLEEVES: Sleeve[] = [
  {
    id: "roth",
    account: "Assets:Investment:Broker:Roth-IRA",
    label: "Roth IRA",
    tax: "roth",
    cash: 134.7,
    limitKey: "ira",
    // On target — the weekly auto-buy keeps it there. Worst drift ~0.5pp.
    targets: { IVV: 55, VB: 10, VEA: 25, VWO: 10 },
    holdings: [
      h(
        "IVV",
        "iShares Core S&P 500 ETF",
        "us-large",
        51.884213,
        759.0,
        655.42
      ),
      h(
        "VEA",
        "Vanguard FTSE Developed Markets ETF",
        "intl-dev",
        240.7118,
        72.3,
        60.74
      ),
      h("VB", "Vanguard Small-Cap ETF", "us-small", 23.41822, 305.64, 266.32),
      h(
        "VWO",
        "Vanguard FTSE Emerging Markets ETF",
        "emerging",
        149.60712,
        47.86,
        40.11
      ),
      // Closed — deliberately sold to remove factor/style overlap.
      h(
        "QUAL",
        "iShares MSCI USA Quality Factor ETF",
        "us-large",
        0,
        220.95,
        0
      ),
      h("SCHG", "Schwab U.S. Large-Cap Growth ETF", "us-large", 0, 33.41, 0),
      h("SPMO", "Invesco S&P 500 Momentum ETF", "us-large", 0, 151.84, 0),
    ],
  },
  {
    id: "hsa",
    account: "Assets:Investment:Broker:HSA",
    label: "HSA",
    tax: "hsa",
    cash: 4218.4,
    limitKey: "hsa",
    // Drifted — US large-cap has run ahead and no new money has corrected it.
    // Worst drift +7.4pp, so the rebalance threshold fires here.
    targets: { SWPPX: 55, SWSSX: 10, MINJX: 25, VEMAX: 10 },
    holdings: [
      h("SWPPX", "Schwab S&P 500 Index Fund", "us-large", 799.412, 19.6, 15.42),
      h(
        "MINJX",
        "MFS International Intrinsic Equity Fund Class R6",
        "intl-dev",
        78.204,
        47.52,
        44.18
      ),
      h(
        "SWSSX",
        "Schwab Small Cap Index Fund",
        "us-small",
        31.088,
        48.16,
        43.02
      ),
      h(
        "VEMAX",
        "Vanguard Emerging Markets Stock Index Fund Admiral Shares",
        "emerging",
        30.412,
        49.14,
        47.86
      ),
      // Closed — the two large-cap style tilts that were removed.
      h(
        "VEIRX",
        "Vanguard Equity-Income Fund Admiral Shares",
        "us-large",
        0,
        98.42,
        0
      ),
      h(
        "VIGIX",
        "Vanguard Growth Index Fund Institutional Shares",
        "us-large",
        0,
        187.3,
        0
      ),
    ],
  },
  {
    id: "brokerage",
    account: "Assets:Investment:Broker:Brokerage",
    label: "Brokerage",
    tax: "taxable",
    // Negative, but inside the interest-free allowance. NOT debt.
    cash: -912.4,
    marginFreeTranche: 1000,
    holdings: [
      h("SPY", "SPDR S&P 500 ETF Trust", "us-large", 9.174855, 772.78, 674.68),
      h(
        "NVDA",
        "NVIDIA Corporation",
        "single-stock",
        17.618215,
        206.43,
        149.16
      ),
      h("TSLA", "Tesla, Inc.", "single-stock", 10.23986, 328.72, 312.31),
      h(
        "SGOV",
        "iShares 0-3 Month Treasury Bond ETF",
        "cash-short",
        28.953954,
        100.42,
        100.58
      ),
      h(
        "META",
        "Meta Platforms, Inc. Class A",
        "single-stock",
        4.108072,
        594.45,
        699.72
      ),
      h(
        "QQQ",
        "Invesco QQQ Trust Series 1",
        "us-large",
        2.539768,
        696.47,
        492.08
      ),
      h("SPCX", "SPAC and New Issue ETF", "single-stock", 15, 125.95, 135.0),
      h("AAPL", "Apple Inc.", "single-stock", 4.477587, 304.16, 254.44),
      h(
        "GOOGL",
        "Alphabet Inc. Class A",
        "single-stock",
        3.169946,
        374.19,
        205.13
      ),
      h(
        "TSM",
        "Taiwan Semiconductor Manufacturing Company Limited",
        "single-stock",
        2.888112,
        419.32,
        337.79
      ),
      h(
        "COST",
        "Costco Wholesale Corporation",
        "single-stock",
        1.357883,
        953.98,
        954.35
      ),
      h(
        "AMD",
        "Advanced Micro Devices, Inc.",
        "single-stock",
        1.45558,
        478.3,
        109.75
      ),
      h("IBIT", "iShares Bitcoin Trust ETF", "crypto", 11.685814, 36.11, 51.92),
      h("INTC", "Intel Corporation", "single-stock", 6, 89.75, 19.0),
      h("RVI", "Retail Value Inc.", "single-stock", 15, 27.91, 25.0),
      h(
        "RAM",
        "Aries I Acquisition Corporation",
        "single-stock",
        31,
        10.1,
        24.03
      ),
      h("DUOL", "Duolingo, Inc. Class A", "single-stock", 3, 137.88, 210.1),
      h(
        "MSFT",
        "Microsoft Corporation",
        "single-stock",
        1.180953,
        496.29,
        415.64
      ),
      h("FIG", "Figma, Inc. Class A", "single-stock", 9, 26.88, 33.0),
      // Closed.
      h("SNOW", "Snowflake Inc. Class A", "single-stock", 0, 214.6, 0),
      h("TQQQ", "ProShares UltraPro QQQ", "single-stock", 0, 92.14, 0),
    ],
  },
  {
    id: "traditional",
    account: "Assets:Investment:Broker:Traditional-IRA",
    label: "Traditional IRA",
    tax: "traditional",
    cash: 0.09,
    limitKey: "ira",
    holdings: [
      h("IVV", "iShares Core S&P 500 ETF", "us-large", 1.884213, 759.0, 512.4),
      h(
        "VEA",
        "Vanguard FTSE Developed Markets ETF",
        "intl-dev",
        8.7118,
        72.3,
        58.1
      ),
      h(
        "VONG",
        "Vanguard Russell 1000 Growth ETF",
        "us-large",
        1.353246,
        128.4,
        94.44
      ),
      h(
        "QUAL",
        "iShares MSCI USA Quality Factor ETF",
        "us-large",
        0.437238,
        220.95,
        173.86
      ),
      h(
        "SPMO",
        "Invesco S&P 500 Momentum ETF",
        "us-large",
        0.624177,
        151.84,
        88.47
      ),
    ],
  },
  {
    id: "crypto",
    account: "Assets:Investment:Broker:Crypto",
    label: "Crypto",
    tax: "taxable",
    cash: 0,
    holdings: [
      h("ETH", "Ethereum", "crypto", 0.300704, 1861.42, 1774.6),
      h("BTC", "Bitcoin", "crypto", 0.0009566, 63681.0, 92401.2),
      h("SOL", "Solana", "crypto", 0.4043938, 74.13, 124.81),
      h("DOGE", "Dogecoin", "crypto", 118.67, 0.07, 0.32),
      h("XRP", "XRP", "crypto", 42.104, 1.94, 2.41),
      h("ADA", "Cardano", "crypto", 31, 0.19, 0.1574),
      h("XLM", "Stellar Lumens", "crypto", 88.4, 0.24, 0.31),
    ],
  },
  {
    id: "workplace",
    account: "Assets:Investment:Workplace:Traditional-401k",
    label: "401(k)",
    tax: "401k",
    cash: 0,
    holdings: [
      h(
        "VTMGX",
        "Vanguard Developed Markets Index Fund Admiral Shares",
        "intl-dev",
        2.883,
        15.29,
        15.29
      ),
      h(
        "VBTLX",
        "Vanguard Total Bond Market Index Fund Admiral Shares",
        "cash-short",
        4.504,
        9.51,
        8.98
      ),
      h(
        "VGSLX",
        "Vanguard Real Estate Index Fund Admiral Shares",
        "us-large",
        1.03,
        140.4,
        125.0
      ),
      h(
        "VTABX",
        "Vanguard Total International Bond Index Fund Admiral Shares",
        "cash-short",
        2.229,
        19.12,
        19.65
      ),
    ],
  },
  {
    id: "legacy",
    account: "Assets:Investment:Legacy:Wallet",
    label: "Legacy wallet",
    tax: "taxable",
    cash: 0,
    // Fully closed sleeve — the empty-state case.
    holdings: [
      h("ETH", "Ethereum", "crypto", 0, 1861.42, 0),
      h("SOL", "Solana", "crypto", 0, 74.13, 0),
    ],
  },
]

// ─── Derived ──────────────────────────────────────────────────────────────

export interface SleeveTotals {
  securitiesCost: number
  securitiesValue: number
  cash: number
  cost: number
  value: number
  gain: number
  gainPct: number
  /** Worst absolute drift in pp across targeted tickers. null = no policy. */
  worstDrift: number | null
  open: Holding[]
  closed: Holding[]
}

export function sleeveTotals(s: Sleeve): SleeveTotals {
  const open = s.holdings.filter((x) => x.units > 0)
  const closed = s.holdings.filter((x) => x.units === 0)
  const securitiesCost = open.reduce((a, x) => a + x.cost, 0)
  const securitiesValue = open.reduce((a, x) => a + x.value, 0)
  const cost = securitiesCost + s.cash
  const value = securitiesValue + s.cash
  return {
    securitiesCost,
    securitiesValue,
    cash: s.cash,
    cost,
    value,
    gain: securitiesValue - securitiesCost,
    gainPct: securitiesCost
      ? ((securitiesValue - securitiesCost) / securitiesCost) * 100
      : 0,
    worstDrift: worstDrift(s, securitiesValue),
    open,
    closed,
  }
}

export interface DriftRow {
  ticker: string
  value: number
  actual: number
  target: number
  drift: number
}

export function driftRows(s: Sleeve): DriftRow[] {
  if (!s.targets) return []
  const open = s.holdings.filter((x) => x.units > 0)
  const total = open.reduce((a, x) => a + x.value, 0)
  const tickers = new Set([
    ...Object.keys(s.targets),
    ...open.map((x) => x.ticker),
  ])
  return [...tickers]
    .map((t) => {
      const value = open.find((x) => x.ticker === t)?.value ?? 0
      const actual = total ? (value / total) * 100 : 0
      const target = s.targets?.[t] ?? 0
      return { ticker: t, value, actual, target, drift: actual - target }
    })
    .filter((r) => r.value > 0 || r.target > 0)
    .sort((a, b) => b.target - a.target || b.value - a.value)
}

function worstDrift(s: Sleeve, _total: number): number | null {
  if (!s.targets) return null
  const rows = driftRows(s)
  return rows.reduce((m, r) => Math.max(m, Math.abs(r.drift)), 0)
}

export const DRIFT_THRESHOLD_PP = 5

export function portfolioTotals() {
  const per = SLEEVES.map(sleeveTotals)
  const cost = per.reduce((a, t) => a + t.cost, 0)
  const value = per.reduce((a, t) => a + t.value, 0)
  const cash = per.reduce((a, t) => a + t.cash, 0)
  const securitiesValue = per.reduce((a, t) => a + t.securitiesValue, 0)
  return {
    cost,
    value,
    cash,
    securitiesValue,
    gain: value - cost,
    gainPct: cost ? ((value - cost) / cost) * 100 : 0,
  }
}

/** Whole-portfolio weights by asset class — 7 buckets, no "Other" needed. */
export function byAssetClass(): {
  key: AssetClass
  label: string
  value: number
  share: number
}[] {
  const acc = new Map<AssetClass, number>()
  for (const s of SLEEVES) {
    for (const x of s.holdings) {
      if (x.units <= 0) continue
      acc.set(x.assetClass, (acc.get(x.assetClass) ?? 0) + x.value)
    }
    if (s.cash > 0) acc.set("cash-short", (acc.get("cash-short") ?? 0) + s.cash)
  }
  const total = [...acc.values()].reduce((a, v) => a + v, 0)
  return [...acc.entries()]
    .map(([key, value]) => ({
      key,
      label: ASSET_CLASS_LABEL[key],
      value,
      share: (value / total) * 100,
    }))
    .sort((a, b) => b.value - a.value)
}

/** Whole-portfolio weights by ticker — 42 rows, the case that will not fold. */
export function byTicker(): {
  key: string
  label: string
  value: number
  share: number
}[] {
  const acc = new Map<string, number>()
  for (const s of SLEEVES) {
    for (const x of s.holdings) {
      if (x.units <= 0) continue
      acc.set(x.ticker, (acc.get(x.ticker) ?? 0) + x.value)
    }
  }
  const total = [...acc.values()].reduce((a, v) => a + v, 0)
  return [...acc.entries()]
    .map(([key, value]) => ({
      key,
      label: key,
      value,
      share: (value / total) * 100,
    }))
    .sort((a, b) => b.value - a.value)
}

export function bySleeve(): {
  key: string
  label: string
  value: number
  share: number
}[] {
  const rows = SLEEVES.map((s) => ({
    key: s.id,
    label: s.label,
    value: sleeveTotals(s).value,
  }))
  const total = rows.reduce((a, r) => a + r.value, 0)
  return rows
    .filter((r) => r.value !== 0)
    .map((r) => ({ ...r, share: (r.value / total) * 100 }))
    .sort((a, b) => b.value - a.value)
}

// ─── Value vs cost time series ────────────────────────────────────────────
// Deterministic pseudo-random walk so the chart is stable across reloads.

function lcg(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

export interface SeriesPoint {
  date: string
  cost: number
  value: number
}

export const SERIES: SeriesPoint[] = (() => {
  const rand = lcg(20260817)
  const totals = portfolioTotals()
  const out: SeriesPoint[] = []
  const months = 34
  let cost = 0
  let drawdownPhase = 0
  for (let i = 0; i < months; i++) {
    const d = new Date(2023, 10 + i, 1)
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    // Contributions ramp up as income grows.
    const monthly = 1900 + i * 78
    cost += monthly
    // Value = cost × a cumulative market factor that wanders, including one
    // real drawdown so the "value below cost" case is represented.
    const t = i / (months - 1)
    let factor = 1 + 0.19 * t
    if (i >= 8 && i <= 12) {
      drawdownPhase = Math.sin(((i - 8) / 4) * Math.PI)
      factor -= 0.11 * drawdownPhase
    }
    factor += (rand() - 0.5) * 0.022
    out.push({
      date: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`,
      cost,
      value: cost * factor,
    })
  }
  // Pin the final point to the actual holdings totals so the chart and the
  // header agree.
  const scaleCost = totals.cost / out[out.length - 1].cost
  const scaleValue = totals.value / out[out.length - 1].value
  return out.map((p) => ({
    date: p.date,
    cost: p.cost * scaleCost,
    value: p.value * scaleValue,
  }))
})()

// ─── Realized gains & dividends ───────────────────────────────────────────

export const REALIZED = [
  { year: 2024, gains: 402.18, dividends: 68.4 },
  { year: 2025, gains: 1884.62, dividends: 812.55 },
  { year: 2026, gains: 4736.09, dividends: 447.83 },
]

// ─── Contribution room ────────────────────────────────────────────────────

export interface ContributionRoom {
  key: "ira" | "hsa"
  label: string
  used: number
  limit: number
  /** Human description of the funding cadence driving the projection. */
  cadence: string
  /** Month the projection reaches the limit, or null if it will fall short. */
  projectedFullBy: string | null
}

export const CONTRIBUTIONS: ContributionRoom[] = [
  {
    key: "ira",
    label: "IRA (Roth + Traditional)",
    used: 5344.32,
    limit: 7500,
    cadence: "$160 / week",
    projectedFullBy: "mid-November",
  },
  {
    key: "hsa",
    label: "HSA",
    used: 2569.0,
    limit: 4400,
    cadence: "$367 / month payroll",
    projectedFullBy: "December",
  },
]

/** Fraction of the calendar year elapsed at ASOF — the pace reference line. */
export const YEAR_ELAPSED = 0.626
