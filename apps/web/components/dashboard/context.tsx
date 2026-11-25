"use client"
// Catalog v3 views: recent spending, market moves, news, the plan timeline
// and insights. Pure display: every list arrives already resolved from the
// data document (`/recent` and `/derived/context`). Each view re-checks item
// shapes itself, because the lkg and default tiers may predate today's data,
// and drops a malformed row instead of crashing.
import { ArrowUpRight } from "lucide-react"
import * as React from "react"

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
  // "2. What to hold" reads "What to hold"; a bare "4" says nothing.
  const sec = section
    ?.replace(SLUG_WORDS, " ")
    .replace(/^\d+(\.\d+)*\.?\s*/, "")
    .trim()
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
        // --primary is a dark crimson; mixing toward --foreground lifts it
        // on dark surfaces and keeps it deep on light (as MerchantAvatar).
        tone === "accent" &&
          "bg-primary/12 text-[color-mix(in_oklab,var(--primary)_65%,var(--foreground))]"
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

/** Rows past `at` hide behind a "Show N more" button. */
function useFold<T>(rows: T[], at: number) {
  const [open, setOpen] = React.useState(false)
  const hidden = open ? 0 : Math.max(0, rows.length - at)
  const button =
    rows.length > at ? (
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="relative mx-4 mt-1 self-start rounded text-xs text-muted-foreground transition-colors duration-150 ease-out before:absolute before:-inset-x-2 before:-inset-y-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {open ? "Show fewer" : `Show ${rows.length - at} more`}
      </button>
    ) : null
  return { visible: hidden ? rows.slice(0, at) : rows, button }
}

// ── RecentActivity ─────────────────────────────────────────────────────

interface RecentGroup extends RecentItem {
  count: number
}

/** Same day, payee and amount fold into one row with a count. */
function groupRepeats(rows: RecentItem[]): RecentGroup[] {
  const out: RecentGroup[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (
      last &&
      last.date === r.date &&
      last.payee === r.payee &&
      last.amount === r.amount
    )
      last.count += 1
    else out.push({ ...r, count: 1 })
  }
  return out
}

/** "Amex-Gold" reads "Amex Gold". */
function accountLabel(a: string): string {
  return a.replace(/[-_]+/g, " ")
}

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
  const all = groupRepeats(
    list<RecentItem>(
      items,
      (r) => isoDate(r.date) && str(r.payee) && isNum(r.amount)
    )
      .filter((r) => {
        if (!withinDays || !asOf) return true
        const d = daysBetween(r.date, asOf)
        return Number.isNaN(d) || d <= withinDays
      })
      .sort((a, b) => b.date.localeCompare(a.date))
  )
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
        // Positive is money spent: an outflow, signed like Overview.
        const total = r.amount * r.count
        const refund = total < 0
        const sub = [
          str(r.category) ? r.category : null,
          showAccount && str(r.account) ? accountLabel(r.account) : null,
        ].filter(Boolean)
        return (
          <li
            key={`${r.date}-${r.payee}-${i}`}
            className="grid h-11 grid-cols-[4.25rem_1.75rem_1fr_auto] items-center gap-2.5 px-4"
          >
            <span className="text-xs text-muted-foreground tabular-nums">
              {relDate(r.date, asOf)}
            </span>
            <MerchantAvatar payee={r.payee} size="md" />
            <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
              <span className="truncate text-sm">
                {r.payee || "Unknown"}
                {r.count > 1 && (
                  <span className="text-muted-foreground"> ×{r.count}</span>
                )}
              </span>
              {sub.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">
                  {sub.join(" · ")}
                </span>
              )}
            </span>
            <Num
              className={cn(
                "text-sm",
                refund && "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {refund ? `+${usd(-total, 2)}` : usd(-total, 2)}
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

/** "30%", or "<1%" for a sliver, never "0% held". */
function weightLabel(w: number): string {
  if (w > 0 && w < 0.005) return "<1%"
  return `${Math.round(w * 100)}%`
}

export function MarketMovesList({
  indices,
  holdings,
  asOf,
  note,
  limit = 6,
}: {
  indices: unknown
  holdings?: unknown
  asOf?: unknown
  note?: unknown
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
  const caption = [asOfCaption(asOf), str(note) && note.trim() ? note : null]
    .filter(Boolean)
    .join(". ")
  if (idx.length === 0 && hold.length === 0)
    return <Empty>No market data today.</Empty>
  return (
    <div className="flex flex-col gap-2">
      {idx.length > 0 && (
        // Indices sit in the panel itself, split by hairlines: no third
        // surface inside the card.
        <ul className="mx-4 grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] divide-x divide-border border-y border-border">
          {idx.map((m) => (
            <li
              key={m.symbol}
              className="flex min-w-0 flex-col gap-0.5 px-3 py-2 first:pl-0"
            >
              <span className="truncate text-xs text-muted-foreground">
                {m.name || m.symbol}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                {isNum(m.price) && (
                  <Num className="text-sm font-medium">{level(m.price)}</Num>
                )}
                {isNum(m.changePct) && (
                  <Num className={cn("text-xs", moveClass(m.changePct))}>
                    {signedPct(m.changePct)}
                  </Num>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hold.length > 0 && (
        <ul className="flex flex-col">
          {hold.map((h) => (
            <li
              key={h.symbol}
              className="flex h-8 items-center gap-3 px-4 text-sm"
            >
              <Num className="w-12 shrink-0 text-xs font-medium">
                {h.symbol}
              </Num>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {h.name}
              </span>
              {isNum(h.weight) && (
                <Num className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                  {weightLabel(h.weight)} held
                </Num>
              )}
              <Num
                className={cn(
                  "w-16 shrink-0 text-right",
                  moveClass(h.changePct)
                )}
              >
                {isNum(h.changePct) ? signedPct(h.changePct) : ""}
              </Num>
            </li>
          ))}
        </ul>
      )}
      {caption && (
        <p className="max-w-[68ch] px-4 text-[11px] leading-snug text-pretty text-muted-foreground">
          {caption}
        </p>
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
        // Tags stay data (for filtering); as words they read as noise.
        const meta = [
          n.source,
          isoDate(n.publishedAt) ? shortDate(n.publishedAt, asOf) : null,
        ].filter(Boolean)
        return (
          <li key={n.id ?? i} className="flex flex-col gap-0.5 px-4 py-2.5">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative inline-flex items-start gap-1 text-sm font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
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
              <p className="mt-0.5 max-w-[68ch] text-[13px] leading-snug text-pretty text-foreground/80">
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

/** Rows shown before "Show N more" in the timeline. */
const PLAN_FOLD = 5

function yearOf(iso: string): string {
  return iso.slice(0, 4)
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
  const capped = all.slice(0, limit)
  const { visible: shown, button } = useFold(capped, PLAN_FOLD)
  if (shown.length === 0) return emptyText ? <Empty>{emptyText}</Empty> : null
  const thisYear = asOf ? yearOf(asOf) : null
  return (
    <div className="flex flex-col">
      <ol className="relative flex flex-col px-4">
        {shown.map((r, i) => {
          const status = PLAN_STATUS[r.status] ?? PLAN_STATUS.open
          const done = r.status === "done"
          const src = sourceLabel(r.source)
          const last = i === shown.length - 1
          const dated = isoDate(r.date)
          // A new year gets one divider; the dates under it drop the year.
          const year = dated ? yearOf(r.date as string) : null
          const prev = shown[i - 1]
          const prevYear =
            prev && isoDate(prev.date) ? yearOf(prev.date) : thisYear
          const newYear = !!year && year !== prevYear
          const when = dated
            ? year === thisYear
              ? relDate(r.date as string, asOf)
              : shortDate(r.date as string, r.date as string)
            : "Undated"
          return (
            <li
              key={r.id ?? i}
              className="grid grid-cols-[3.75rem_0.75rem_1fr] gap-x-2.5"
            >
              {newYear && (
                <span className="col-span-3 pt-2 pb-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                  {year}
                </span>
              )}
              <span className="pt-2 text-xs text-muted-foreground tabular-nums">
                {when}
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
                  {/* Upcoming is the default: only the exceptions get a tag. */}
                  {r.status !== "upcoming" && (
                    <SmallTag tone={status.tone}>{status.label}</SmallTag>
                  )}
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
      {button}
      <More n={all.length - capped.length} />
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
  const when = isoDate(x.date) ? relDate(x.date, asOf) : null
  // The tag sits on its own line with the date, so a wrapped title never
  // hangs off the tag's right edge.
  return (
    <>
      <div className="flex items-center gap-2">
        <SmallTag tone={tag.tone}>{tag.label}</SmallTag>
        {when && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {when}
          </span>
        )}
      </div>
      <div className="flex items-start gap-2">
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
      {src && <p className="text-[11px] text-muted-foreground">{src}</p>}
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
    // Tinted tiles inside the panel, not cards in a card: no second ring,
    // and a radius stepped down from the panel's 12px (6px, 8px in).
    return (
      <ul className="grid grid-cols-1 gap-2 px-2 @lg/panel:grid-cols-2 *:min-w-0">
        {shown.map((x, i) => (
          <li
            key={x.id ?? i}
            className="flex flex-col gap-1.5 rounded-md bg-muted/60 px-3.5 py-3"
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
