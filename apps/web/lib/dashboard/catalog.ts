// The dashboard catalog: the components an agent may compose into the Home
// spec, their props (as the agent writes them), and the `$format` directive
// for amounts inside text. See README.md in this folder.
//
// Bump CATALOG_VERSION whenever a component is added or removed, or a prop
// changes shape. The daily agent is prompted from the deployed version.
//
// Descriptions say what a component shows and what it handles, never where
// to put it or when to lead with it. This file is public and fixed, and the
// agent reads it every day: placement advice here would harden into the same
// layout every day. Placement belongs to the ledger's private standards doc.
import {
  defineCatalog,
  defineDirective,
  resolvePropValue,
} from "@json-render/core"
import { concatDirective } from "@json-render/directives"
import { schema } from "@json-render/react/schema"
import { z } from "zod"

import { formatMoney } from "../format"
import { bound, FormatExpr, literalText, type Resolve, richText } from "./bound"

export const CATALOG_VERSION = 3

// ── Data shapes behind the bindings (snapshot schema 2 + /derived) ─────

export type PlanEventKind = "pay" | "card" | "bill" | "info"
export interface PlanEvent {
  id: string
  date: string
  label: string
  note: string
  amount: number
  kind: PlanEventKind
  balance: number
  fundedByName?: string | null
}
export interface NeedsYouItem {
  date: string
  title: string
  detail: string
  kind: "card" | "date"
}
export interface SeriesPoint {
  date: string
  netWorth: number
  invest: number
  cash: number
}
export interface FreshnessInfo {
  asOf: string
  generatedAt: string
  ledgerCommit: string | null
  /** null when git is unavailable. */
  ledgerDirty: boolean | null
}
export interface StaleAccount {
  account: string
  reason: string
}
export type FindingKind =
  | "drift"
  | "settled"
  | "opened"
  | "statement"
  | "skip"
  | "note"
/** One finding of the daily reconcile run (`/derived/findings`). */
export interface FindingItem {
  id: string
  kind: FindingKind
  title: string
  amount: number | null
  /** drift: the forecast amount. */
  from: number | null
  /** drift: the actual amount. */
  to: number | null
  account: string | null
  date: string | null
}

/** One recent transaction (`/recent`). amount positive = money spent. */
export interface RecentItem {
  date: string
  payee: string
  note?: string
  amount: number
  category: string
  account: string
  logoDomain?: string | null
}

// The daily agent's context file (`/derived/context`): market moves, news,
// plan steps and insights summarized from the planning docs. Every list is
// present (possibly empty) and every scalar may be null.

/** One market index (`/derived/context/market/indices`). */
export interface MarketIndex {
  symbol: string
  name: string
  price: number | null
  change: number | null
  /** A fraction: 0.0123 is +1.23%. */
  changePct: number | null
}
/** One portfolio holding's move (`/derived/context/market/holdings`). */
export interface MarketHolding {
  symbol: string
  name: string
  /** A fraction: 0.0123 is +1.23%. */
  changePct: number | null
  /** Share of the portfolio, a fraction. */
  weight: number | null
}
/** One news item (`/derived/context/news`). */
export interface NewsItem {
  id: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  relevance: string
  tags: string[]
}
export type PlanStepStatus = "upcoming" | "due" | "done" | "open"
/** One step of the near-term plan (`/derived/context/plan`). */
export interface PlanStep {
  id: string
  date: string | null
  title: string
  detail: string
  /** The planning doc it came from, e.g. "docs/plan.md#section". */
  source: string
  status: PlanStepStatus
}
export const INSIGHT_KINDS = [
  "plan",
  "decision",
  "risk",
  "opportunity",
  "reminder",
] as const
export type InsightKind = (typeof INSIGHT_KINDS)[number]
/** One insight drawn from the planning docs (`/derived/context/insights`). */
export interface Insight {
  id: string
  kind: InsightKind
  title: string
  body: string
  date: string | null
  source: string
  amount: number | null
}

// ── Shared enums ───────────────────────────────────────────────────────

const Gap = z.enum(["sm", "md", "lg"]).default("md")
/** Tone maps to globals.css tokens in the registry; never a raw color. */
const NoteTone = z.enum(["info", "warn", "crit"])
const TileTone = z.enum(["neutral", "pos", "warn", "crit"])
const ValueFormat = z
  .enum(["money", "money2", "percent", "number"])
  .describe(
    "money = whole dollars, money2 = cents, percent = a 0..1 fraction as %"
  )
const Height = z.enum(["sm", "md", "lg"])

// ── Components ─────────────────────────────────────────────────────────

const components = {
  Stack: {
    props: z.strictObject({
      direction: z.enum(["vertical", "horizontal"]).default("vertical"),
      gap: Gap,
    }),
    slots: ["default"],
    description:
      "Layout: stacks its children vertically (default) or horizontally. The page root is a vertical Stack.",
  },
  Grid: {
    props: z.strictObject({
      columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      ratio: z
        .enum(["equal", "wide-left", "wide-right"])
        .default("equal")
        .describe("2 columns only: wide-left is about 3:2, wide-right 2:3"),
      gap: Gap,
    }),
    slots: ["default"],
    description:
      "Layout: puts children side by side in 1 to 3 columns; collapses to one column on narrow screens. Each child is one cell, so wrap several items for one column in a vertical Stack.",
  },
  Panel: {
    props: z.strictObject({
      title: literalText(40, { allowYears: true }),
      eyebrow: literalText(40, { allowYears: true }).optional(),
    }),
    slots: ["default", "action"],
    description:
      "A titled card that groups related content (a list, a chart, a set of tiles). The optional eyebrow is a small caption above the title; title and eyebrow are the only text that may hold a year. The 'action' slot holds one short element in the header. Do not nest Panels.",
  },
  Note: {
    props: z.strictObject({
      tone: NoteTone.default("info"),
      title: literalText(60).optional(),
      text: richText(280).describe(
        'Plain words, or { "$concat": [...] } mixing words with { "$format": ..., "value": { "$state": ... } } amounts. Never type a number.'
      ),
    }),
    slots: [],
    description:
      "The agent's brief: one or two sentences in its own words. tone sets the accent (info, warn, crit). At most one Note per issue. Every amount in the text is a $format of a binding.",
  },
  NetWorthHero: {
    props: z.strictObject({
      label: literalText(40).default("Net worth"),
      value: bound<number>().describe("/netWorth/value"),
      d30: bound<number>()
        .optional()
        .describe("/netWorth/d30, change over 30 days"),
      ytd: bound<number>()
        .optional()
        .describe("/netWorth/ytd, change since Jan 1"),
      series: bound<SeriesPoint[]>().optional().describe("/netWorth/series"),
      field: z
        .enum(["netWorth", "invest", "cash"])
        .default("netWorth")
        .describe("which series field the line plots"),
    }),
    slots: [],
    description:
      "Net worth large, its 30-day and year-to-date change, and a trend line of the chosen series field.",
  },
  StatTile: {
    props: z.strictObject({
      label: literalText(40),
      value: bound<number>(),
      format: ValueFormat.default("money"),
      delta: bound<number>()
        .optional()
        .describe("change shown beside the value, same format"),
      deltaLabel: literalText(24)
        .optional()
        .describe("e.g. '30d' or 'vs usual'"),
      goodWhen: z
        .enum(["up", "down"])
        .default("up")
        .describe("which delta direction is good; spending is 'down'"),
      caption: literalText(80).optional(),
      spark: bound<number[] | SeriesPoint[]>()
        .optional()
        .describe("an array of numbers, or of objects with sparkField"),
      sparkField: z.string().max(32).optional(),
      tone: TileTone.default("neutral"),
    }),
    slots: [],
    description:
      "One KPI: a label, a bound value, an optional delta with direction-aware color and an optional sparkline. format percent needs a 0..1 fraction. A spark of objects needs sparkField naming a numeric field on each item. Use tone warn or crit only when the value crosses a standards threshold.",
  },
  PaceChart: {
    props: z.strictObject({
      mtdCurve: bound<number[]>().describe("/spend/flex/mtdCurve"),
      usualCurve: bound<number[]>().describe("/spend/flex/usualCurve"),
      usualMonth: bound<number>().optional().describe("/spend/flex/usualMonth"),
      delta: bound<number>()
        .optional()
        .describe("/derived/paceDelta, negative = under usual"),
      height: Height.default("sm"),
    }),
    slots: [],
    description:
      "Day-to-day spending this month as a cumulative line against the usual month (dashed). With delta bound, it heads the chart with 'X under/over usual'.",
  },
  EventList: {
    props: z.strictObject({
      items: bound<PlanEvent[]>().describe("/plan/events"),
      limit: z.number().int().min(1).max(30).default(8),
      kinds: z
        .array(z.enum(["pay", "card", "bill", "info"]))
        .min(1)
        .optional()
        .describe("only these event kinds; all when omitted"),
      withinDays: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("only events up to this many days after asOf"),
      showBalance: z
        .boolean()
        .default(true)
        .describe("show projected cash after each event"),
    }),
    slots: [],
    description:
      "Scheduled cash events in date order: paychecks, card payments, bills, reminders, each with its amount and the projected cash after it. kinds and withinDays filter the list. Handles an empty list itself.",
  },
  NeedsYou: {
    props: z.strictObject({
      items: bound<NeedsYouItem[]>().describe("/derived/needsYou"),
      limit: z.number().int().min(1).max(12).default(6),
      emptyText: literalText(80).optional(),
    }),
    slots: [],
    description:
      "Upcoming items: card statements due within 21 days and key dates within 30, soonest first, each with a relative date. Handles an empty list itself.",
  },
  Findings: {
    props: z.strictObject({
      items: bound<FindingItem[]>().describe("/derived/findings"),
      limit: z.number().int().min(1).max(20).default(6),
      emptyText: literalText(80).optional(),
    }),
    slots: [],
    description:
      "What today's reconcile run found (forecast drift, items settled or opened, statements, skips, notes), one row each with its title, account, date and formatted amount; a drift row shows forecast -> actual. Rows come from the run's findings file, so amounts are bound, never typed. Handles an empty list itself.",
  },
  RecentActivity: {
    props: z.strictObject({
      items: bound<RecentItem[]>().describe("/recent"),
      limit: z.number().int().min(1).max(30).default(8),
      withinDays: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("only transactions up to this many days before asOf"),
      showAccount: z
        .boolean()
        .default(true)
        .describe("show the account or card under each payee"),
    }),
    slots: [],
    description:
      "Latest transactions, newest first: date, payee with its logo, category, optional account, and the amount (positive is money spent, shown as an outflow; negative is a refund or credit). withinDays filters by age. Handles an empty list itself.",
  },
  MarketMoves: {
    props: z.strictObject({
      indices: bound<MarketIndex[]>().describe(
        "/derived/context/market/indices"
      ),
      holdings: bound<MarketHolding[]>()
        .optional()
        .describe("/derived/context/market/holdings"),
      asOf: bound<string | null>()
        .optional()
        .describe("/derived/context/market/asOf"),
      limit: z.number().int().min(1).max(15).default(6),
    }),
    slots: [],
    description:
      "Market indices with level and daily change, and optionally the portfolio's holdings with their daily change and weight, colored by direction. limit caps each list. With asOf bound, shows when the quotes were taken. Handles empty lists and missing quotes itself.",
  },
  NewsList: {
    props: z.strictObject({
      items: bound<NewsItem[]>().describe("/derived/context/news"),
      limit: z.number().int().min(1).max(8).default(5),
      emptyText: literalText(80).optional(),
    }),
    slots: [],
    description:
      "Headlines the daily run collected, each a link with its source, date, tags and a line on why it matters here. Handles an empty list itself.",
  },
  PlanTimeline: {
    props: z.strictObject({
      items: bound<PlanStep[]>().describe("/derived/context/plan"),
      limit: z.number().int().min(1).max(20).default(8),
      withinDays: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "only dated steps up to this many days after asOf; undated steps stay"
        ),
      emptyText: literalText(80).optional(),
    }),
    slots: [],
    description:
      "Near-term plan steps from the planning docs in date order, undated ones last: title, detail, status (upcoming, due, done, open) and the doc it came from. withinDays filters dated steps. Handles an empty list itself.",
  },
  Insights: {
    props: z.strictObject({
      items: bound<Insight[]>().describe("/derived/context/insights"),
      limit: z.number().int().min(1).max(8).default(4),
      kinds: z
        .array(z.enum(INSIGHT_KINDS))
        .min(1)
        .optional()
        .describe("only these insight kinds; all when omitted"),
      layout: z
        .enum(["list", "cards"])
        .default("list")
        .describe("list = compact rows; cards = one card per insight"),
    }),
    slots: [],
    description:
      "Insights the daily run drew from the planning docs (plan, decision, risk, opportunity, reminder), each with a title, a short body, an optional date and amount, and its source doc. kinds filters. Handles an empty list itself.",
  },
  Freshness: {
    props: z.strictObject({
      freshness: bound<FreshnessInfo>().describe("/derived/freshness"),
      stale: bound<StaleAccount[]>().optional().describe("/derived/stale"),
      compact: z.boolean().default(true),
    }),
    slots: [],
    description:
      "How current the numbers are: the ledger as-of date, when the data was built, an uncommitted-ledger mark, and any accounts whose statements were skipped. compact true is one small line; compact false shows the full detail.",
  },
}

export const catalog = defineCatalog(schema, { components, actions: {} })

export type DashboardCatalog = typeof catalog
export type ComponentName = keyof typeof components
export const COMPONENT_NAMES = Object.keys(components) as ComponentName[]

/** Props of a component as the agent writes them (bindings unresolved). */
export type SpecProps<K extends ComponentName> = z.infer<
  (typeof components)[K]["props"]
>
/** Props of a component as the registry receives them (bindings resolved). */
export type ResolvedProps<K extends ComponentName> = Resolve<SpecProps<K>>

// ── Directives: amounts in text ────────────────────────────────────────

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  if (!y || !m || !d) return iso
  const year = y !== new Date().getFullYear() ? `, ${y}` : ""
  return `${MONTHS[m - 1]} ${d}${year}`
}

/**
 * The app's `$format`. Same shape as `@json-render/directives` `$format`, but
 * `value` must be a binding, currency goes through the app's formatMoney
 * (U+2212 minus), and ISO dates are read as local calendar dates.
 */
export const formatDirective = defineDirective({
  name: "$format",
  description:
    'Formats a bound value for text. currency: whole dollars (digits 2 for cents), signed adds +, abs drops the sign. percent: a 0..1 fraction. date: an ISO date as "Dec 7". value must be { "$state": pointer }.',
  schema: FormatExpr,
  resolve(raw, ctx) {
    const v = resolvePropValue(raw.value, ctx)
    if (v === undefined || v === null) return "n/a"
    switch (raw.$format) {
      case "date":
        return formatDate(String(v))
      case "percent":
        return `${Math.round(Number(v) * 100)}%`
      default: {
        const n = raw.abs ? Math.abs(Number(v)) : Number(v)
        if (!Number.isFinite(n)) return "n/a"
        const plus = raw.signed && n > 0 ? "+" : ""
        const digits = raw.digits ?? 0
        const body =
          raw.$format === "currency"
            ? formatMoney(n, {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
              })
            : `${n < 0 ? "\u2212" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
        return plus + body
      }
    }
  },
})

/** Directives the dashboard spec may use; pass to the renderer and prompt. */
export const directives = [formatDirective, concatDirective]
