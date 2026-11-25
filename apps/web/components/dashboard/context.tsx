"use client"
// Catalog v3 views: recent spending, market moves, news, the plan timeline
// and insights. Pure display: every list arrives already resolved from the
// data document (`/recent` and `/derived/context`). Each view re-checks item
// shapes itself, because the lkg and default tiers may predate today's data,
// and drops a malformed row instead of crashing.
import { ArrowUpRight } from "lucide-react"
import type * as React from "react"

import { daysBetween, relDate, shortDate } from "@/components/dashboard/dates"
import { Empty, isNum, Num, usd } from "@/components/dashboard/parts"
import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import type {
  Insight,
  InsightKind,
  MarketHolding,
  MarketIndex,
  NewsItem,
  PlanStep,
  PlanStepStatus,
  RecentItem,
} from "@/lib/dashboard/catalog"
import { MINUS } from "@/lib/format"
import { cn } from "@/lib/utils"

// ── Helpers ────────────────────────────────────────────────────────────

function list<T>(v: unknown, ok: (x: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (x): x is T =>
      !!x && typeof x === "object" && ok(x as Record<string, unknown>)
  )
}

const str = (v: unknown): v is string => typeof v === "string"
const isoDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)

/** "+1.23%" / "−0.45%" for a 0..1 fraction; zero has no sign. */
export function signedPct(fraction: number): string {
  const pct = fraction * 100
  const body = Math.abs(pct).toFixed(2)
  if (body === "0.00") return "0.00%"
  return `${pct > 0 ? "+" : MINUS}${body}%`
}

/** A plain number with grouping, for index levels (not dollars). */
function level(n: number, digits = 2): string {
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${n < 0 ? MINUS : ""}${body}`
}

function signedLevel(n: number): string {
  return `${n > 0 ? "+" : ""}${level(n)}`
}

function moveClass(n: number | null): string {
  if (!isNum(n) || n === 0) return "text-muted-foreground"
  return n > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400"
}

/** Only an http(s) URL becomes a link. */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string") return null
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

const SLUG_WORDS = /[-_]+/g

/**
 * A quiet caption for a doc path: "docs/planning/short-term-plan.md#december"
 * reads "short-term plan · december". Dated prefixes are dropped.
 */
export function sourceLabel(source: unknown): string | null {
  if (typeof source !== "string" || !source.trim()) return null
  const [path, section] = source.trim().split("#", 2)
  const base = (path.split("/").pop() ?? path)
    .replace(/\.(md|markdown|txt|yaml|yml|json)$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
  const name = base
    .replace(SLUG_WORDS, " ")
    .replace(/\b(short|mid|long) term\b/gi, "$1-term")
    .trim()
  const sec = section?.replace(SLUG_WORDS, " ").trim()
  return [name, sec].filter(Boolean).join(" · ")
}

function SmallTag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode
  tone?: "muted" | "warn" | "pos" | "accent"
}) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-px text-[11px] leading-4",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "warn" && "bg-runway-warn/12 text-runway-warn",
        tone === "pos" &&
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        tone === "accent" && "bg-primary/10 text-primary"
      )}
    >
      {children}
    </span>
  )
}

function More({ n }: { n: number }) {
  if (n <= 0) return null
  return <div className="px-4 pt-1 text-xs text-muted-foreground">{n} more</div>
}

// ── RecentActivity ─────────────────────────────────────────────────────

export function RecentActivityList({
  items,
  limit = 8,
  withinDays,
  showAccount = true,
  asOf,
}: {
  items: unknown
  limit?: number
  withinDays?: number
  showAccount?: boolean
  asOf?: string
}) {
  const all = list<RecentItem>(
    items,
    (r) => isoDate(r.date) && str(r.payee) && isNum(r.amount)
  )
    .filter((r) => {
      if (!withinDays || !asOf) return true
      const d = daysBetween(r.date, asOf)
      return Number.isNaN(d) || d <= withinDays
    })
    .sort((a, b) => b.date.localeCompare(a.date))
  const shown = all.slice(0, limit)
  if (shown.length === 0)
    return (
      <Empty>
        {withinDays
          ? `No spending in the last ${withinDays} days.`
          : "No recent spending."}
      </Empty>
    )
  return (
    <ul className="flex flex-col">
      {shown.map((r, i) => {
        const refund = r.amount < 0
        const sub = [
          str(r.category) ? r.category : null,
          showAccount && str(r.account) ? r.account : null,
        ].filter(Boolean)
        return (
          <li
            key={`${r.date}-${r.payee}-${i}`}
            className="grid h-11 grid-cols-[3.25rem_1.75rem_1fr_auto] items-center gap-2.5 px-4"
          >
            <Num className="text-xs text-muted-foreground">
              {relDate(r.date, asOf)}
            </Num>
            <MerchantAvatar payee={r.payee} size="md" />
            <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
              <span className="truncate text-sm">{r.payee || "Unknown"}</span>
              {sub.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">
                  {sub.join(" · ")}
                </span>
              )}
            </span>
            <Num
              className={cn(
                "text-sm font-medium",
                refund && "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {refund ? `+${usd(-r.amount, 2)}` : usd(r.amount, 2)}
            </Num>
          </li>
        )
      })}
      <More n={all.length - shown.length} />
    </ul>
  )
}

// ── MarketMoves ────────────────────────────────────────────────────────

function asOfCaption(asOf: unknown): string | null {
  if (typeof asOf !== "string") return null
  const t = Date.parse(asOf)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const time =
    asOf.length > 10
      ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : null
  return `As of ${date}${time ? `, ${time}` : ""}`
}

export function MarketMovesList({
  indices,
  holdings,
  asOf,
  limit = 6,
}: {
  indices: unknown
  holdings?: unknown
  asOf?: unknown
  limit?: number
}) {
  const idx = list<MarketIndex>(indices, (r) => str(r.symbol)).slice(0, limit)
  const hold = list<MarketHolding>(holdings, (r) => str(r.symbol))
    .sort(
      (a, b) =>
        Math.abs(isNum(b.changePct) ? b.changePct : 0) -
        Math.abs(isNum(a.changePct) ? a.changePct : 0)
    )
    .slice(0, limit)
  const caption = asOfCaption(asOf)
  if (idx.length === 0 && hold.length === 0)
    return <Empty>No market data today.</Empty>
  return (
    <div className="flex flex-col gap-2 py-1">
      {idx.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-3">
          {idx.map((m) => (
            <li
              key={m.symbol}
              className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2"
            >
              <span className="truncate text-xs text-muted-foreground">
                {m.name || m.symbol}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                {isNum(m.price) && (
                  <Num className="text-sm font-medium">{level(m.price)}</Num>
                )}
                <Num className={cn("text-xs", moveClass(m.changePct))}>
                  {isNum(m.changePct) ? signedPct(m.changePct) : "n/a"}
                </Num>
              </span>
              {isNum(m.change) && (
                <Num className="text-[11px] text-muted-foreground">
                  {signedLevel(m.change)}
                </Num>
              )}
            </li>
          ))}
        </ul>
      )}
      {hold.length > 0 && (
        <ul className="flex flex-col">
          {hold.map((h) => (
            <li
              key={h.symbol}
              className="flex items-center gap-3 px-4 py-1.5 text-sm"
            >
              <Num className="w-14 shrink-0 text-xs font-medium">
                {h.symbol}
              </Num>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {h.name}
              </span>
              {isNum(h.weight) && (
                <Num className="shrink-0 text-xs text-muted-foreground">
                  {Math.round(h.weight * 100)}% held
                </Num>
              )}
              <Num
                className={cn(
                  "w-16 shrink-0 text-right",
                  moveClass(h.changePct)
                )}
              >
                {isNum(h.changePct) ? signedPct(h.changePct) : "n/a"}
              </Num>
            </li>
          ))}
        </ul>
      )}
      {caption && (
        <p className="px-4 text-[11px] text-muted-foreground">{caption}</p>
      )}
    </div>
  )
}

// ── NewsList ───────────────────────────────────────────────────────────

export function NewsListView({
  items,
  limit = 5,
  emptyText,
  asOf,
}: {
  items: unknown
  limit?: number
  emptyText?: string
  asOf?: string
}) {
  const all = list<NewsItem>(items, (r) => str(r.title) && str(r.source))
  const shown = all.slice(0, limit)
  if (shown.length === 0) return emptyText ? <Empty>{emptyText}</Empty> : null
  return (
    <ul className="flex flex-col">
      {shown.map((n, i) => {
        const href = safeHref(n.url)
        const tags = Array.isArray(n.tags)
          ? n.tags.filter((t): t is string => str(t) && t.length > 0)
          : []
        const meta = [
          n.source,
          isoDate(n.publishedAt) ? shortDate(n.publishedAt, asOf) : null,
          ...tags.slice(0, 3),
        ].filter(Boolean)
        return (
          <li key={n.id ?? i} className="flex flex-col gap-0.5 px-4 py-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-start gap-1 text-sm font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
              >
                <span className="min-w-0 text-pretty">{n.title}</span>
                <ArrowUpRight
                  size={13}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground"
                />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span className="text-sm font-medium text-pretty">{n.title}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {meta.join(" · ")}
            </span>
            {str(n.relevance) && n.relevance && (
              <p className="max-w-[68ch] text-[13px] leading-snug text-pretty text-foreground/80">
                {n.relevance}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ── PlanTimeline ───────────────────────────────────────────────────────

const PLAN_STATUS: Record<
  PlanStepStatus,
  { label: string; tone: "muted" | "warn" | "pos" | "accent" }
> = {
  due: { label: "Due", tone: "warn" },
  upcoming: { label: "Upcoming", tone: "muted" },
  open: { label: "Open", tone: "accent" },
  done: { label: "Done", tone: "pos" },
}

export function PlanTimelineView({
  items,
  limit = 8,
  withinDays,
  emptyText,
  asOf,
}: {
  items: unknown
  limit?: number
  withinDays?: number
  emptyText?: string
  asOf?: string
}) {
  const all = list<PlanStep>(items, (r) => str(r.title))
    .filter((r) => {
      if (!withinDays || !asOf || !isoDate(r.date)) return true
      return daysBetween(asOf, r.date) <= withinDays
    })
    .sort((a, b) => {
      const da = isoDate(a.date) ? a.date : "9999"
      const db = isoDate(b.date) ? b.date : "9999"
      return da.localeCompare(db)
    })
  const shown = all.slice(0, limit)
  if (shown.length === 0) return emptyText ? <Empty>{emptyText}</Empty> : null
  return (
    <div className="flex flex-col">
      <ol className="relative flex flex-col px-4">
        {shown.map((r, i) => {
          const status = PLAN_STATUS[r.status] ?? PLAN_STATUS.open
          const done = r.status === "done"
          const src = sourceLabel(r.source)
          const last = i === shown.length - 1
          return (
            <li
              key={r.id ?? i}
              className="grid grid-cols-[4.25rem_0.75rem_1fr] gap-x-2.5"
            >
              <span className="pt-2 text-xs text-muted-foreground tabular-nums">
                {isoDate(r.date) ? relDate(r.date, asOf) : "Undated"}
              </span>
              <span aria-hidden="true" className="relative flex justify-center">
                {shown.length > 1 && (
                  <span
                    className={cn(
                      "absolute w-px bg-border",
                      i === 0 ? "top-3" : "top-0",
                      last ? "h-3" : "bottom-0"
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative mt-[9px] size-2 rounded-full ring-2 ring-card",
                    r.status === "due"
                      ? "bg-runway-warn"
                      : done
                        ? "bg-emerald-500"
                        : r.status === "open"
                          ? "bg-primary"
                          : "bg-muted-foreground/60"
                  )}
                />
              </span>
              <div className={cn("min-w-0 py-1.5", done && "opacity-70")}>
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm font-medium text-pretty",
                      done &&
                        "text-muted-foreground line-through decoration-muted-foreground/50"
                    )}
                  >
                    {r.title}
                  </span>
                  <SmallTag tone={status.tone}>{status.label}</SmallTag>
                </div>
                {str(r.detail) && r.detail && (
                  <p className="mt-0.5 max-w-[68ch] text-[13px] leading-snug text-pretty text-foreground/80">
                    {r.detail}
                  </p>
                )}
                {src && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {src}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <More n={all.length - shown.length} />
    </div>
  )
}

// ── Insights ───────────────────────────────────────────────────────────

const INSIGHT_TAG: Record<
  InsightKind,
  { label: string; tone: "muted" | "warn" | "pos" | "accent" }
> = {
  plan: { label: "Plan", tone: "muted" },
  decision: { label: "Decision", tone: "accent" },
  risk: { label: "Risk", tone: "warn" },
  opportunity: { label: "Opportunity", tone: "pos" },
  reminder: { label: "Reminder", tone: "muted" },
}

function InsightBody({ x, asOf }: { x: Insight; asOf?: string }) {
  const tag = INSIGHT_TAG[x.kind] ?? INSIGHT_TAG.plan
  const src = sourceLabel(x.source)
  const foot = [isoDate(x.date) ? relDate(x.date, asOf) : null, src].filter(
    Boolean
  )
  return (
    <>
      <div className="flex items-start gap-2">
        <SmallTag tone={tag.tone}>{tag.label}</SmallTag>
        <span className="min-w-0 flex-1 text-sm font-medium text-pretty">
          {x.title}
        </span>
        {isNum(x.amount) && (
          <Num className="shrink-0 text-sm">{usd(x.amount)}</Num>
        )}
      </div>
      {str(x.body) && x.body && (
        <p className="max-w-[68ch] text-[13px] leading-snug text-pretty text-foreground/85">
          {x.body}
        </p>
      )}
      {foot.length > 0 && (
        <p className="text-[11px] text-muted-foreground">{foot.join(" · ")}</p>
      )}
    </>
  )
}

export function InsightsView({
  items,
  limit = 4,
  kinds,
  layout = "list",
  asOf,
}: {
  items: unknown
  limit?: number
  kinds?: readonly string[]
  layout?: "list" | "cards"
  asOf?: string
}) {
  const want = kinds && kinds.length > 0 ? new Set(kinds) : null
  const all = list<Insight>(items, (r) => str(r.title) && str(r.kind)).filter(
    (x) => !want || want.has(x.kind)
  )
  const shown = all.slice(0, limit)
  if (shown.length === 0) return null
  if (layout === "cards")
    return (
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 *:min-w-0">
        {shown.map((x, i) => (
          <li
            key={x.id ?? i}
            className="flex flex-col gap-1.5 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10"
          >
            <InsightBody x={x} asOf={asOf} />
          </li>
        ))}
      </ul>
    )
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {shown.map((x, i) => (
        <li key={x.id ?? i} className="flex flex-col gap-1 px-4 py-2.5">
          <InsightBody x={x} asOf={asOf} />
        </li>
      ))}
      {all.length > shown.length && (
        <li className="px-4 pt-1.5 text-xs text-muted-foreground">
          {all.length - shown.length} more
        </li>
      )}
    </ul>
  )
}
