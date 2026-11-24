"use client"
// Per-section context below the page links: what the sidebar's second level
// shows beyond navigation. Shared by the desktop panel, the hover flyout and
// the mobile switcher sheet (touch=true gives 44px rows).

import { Bookmark } from "lucide-react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import * as React from "react"

import { usePeriodHref } from "@/components/layout/ui-state"
import { AccountDot } from "@/components/primitives/account-dot"
import { useBalanceSheet } from "@/hooks/use-fava"
import { usePlanGrid } from "@/hooks/use-plan"
import { useResolvedUIConfig, useUIConfig } from "@/lib/config"
import { formatMoney, formatRelativeDate } from "@/lib/format"
import type { BalanceTreeNode } from "@/lib/types/views"
import { cn } from "@/lib/utils"

// Whole dollars; anything that rounds to zero reads "$0", never "-$0".
const money = (n: number) =>
  formatMoney(Math.round(n) === 0 ? 0 : n, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })

function total(node: BalanceTreeNode | undefined): number {
  if (!node) return 0
  return node.balanceChildren?.USD ?? node.balance?.USD ?? 0
}

function find(
  node: BalanceTreeNode | undefined,
  path: string
): BalanceTreeNode | undefined {
  if (!node) return undefined
  if (node.account === path) return node
  for (const c of node.children) {
    if (path === c.account || path.startsWith(`${c.account}:`)) {
      return find(c, path)
    }
  }
  return undefined
}

function ExtraLabel({
  children,
  touch,
}: {
  children: React.ReactNode
  touch?: boolean
}) {
  return (
    <div
      className={cn(
        "px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase",
        touch && "pt-3"
      )}
    >
      {children}
    </div>
  )
}

function ExtraRow({
  href,
  label,
  sub,
  value,
  valueTone,
  leading,
  active,
  touch,
  onNavigate,
}: {
  href: string
  label: string
  sub?: string
  value?: string
  valueTone?: "pos" | "neg"
  leading?: React.ReactNode
  active?: boolean
  touch?: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 transition-[background-color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring",
        touch
          ? "min-h-11 touch-manipulation rounded-xl text-[15px] select-none active:bg-muted"
          : "py-1 text-[13px] hover:bg-(--nav-hover)",
        active && (touch ? "bg-muted" : "bg-(--nav-current)")
      )}
    >
      {leading && (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {leading}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-tight">{label}</span>
        {sub && (
          <span className="block truncate text-xs leading-tight text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
      {value && (
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            valueTone === "neg"
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground"
          )}
        >
          {value}
        </span>
      )}
    </Link>
  )
}

/** Placeholder rows sized like real ones so the panel doesn't reflow. */
function Skeletons({ n, touch }: { n: number; touch?: boolean }) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          className={cn(
            "flex items-center gap-2.5 px-2",
            touch ? "h-11" : "h-7"
          )}
        >
          <span className="h-2.5 flex-1 rounded bg-muted" />
          <span className="h-2.5 w-12 rounded bg-muted" />
        </div>
      ))}
    </>
  )
}

// ── Accounts: top-level account groups with today's balance ─────────────

function AccountGroups({ touch, onNavigate }: Props) {
  const periodHref = usePeriodHref()
  const pathname = usePathname()
  const bs = useBalanceSheet()
  const rows = React.useMemo(() => {
    const out: {
      path: string
      label: string
      root: "Assets" | "Liabilities"
      v: number
    }[] = []
    for (const root of ["Assets", "Liabilities"] as const) {
      for (const c of bs.data?.trees[root]?.children ?? []) {
        const v = total(c)
        if (Math.abs(v) < 0.5) continue
        out.push({ path: c.account, label: c.segment, root, v })
      }
    }
    return out
  }, [bs.data])

  return (
    <>
      <ExtraLabel touch={touch}>Account groups</ExtraLabel>
      <div className="flex flex-col gap-0.5">
        {!bs.data ? (
          <Skeletons n={5} touch={touch} />
        ) : (
          rows.map((r) => {
            const href = `/account/${r.path.split(":").join("/")}`
            return (
              <ExtraRow
                key={r.path}
                href={periodHref(href)}
                label={r.label}
                value={money(r.v)}
                valueTone={Math.round(r.v) < 0 ? "neg" : undefined}
                leading={<AccountDot root={r.root} />}
                active={pathname === href}
                touch={touch}
                onNavigate={onNavigate}
              />
            )
          })
        )}
      </div>
    </>
  )
}

// ── Activity: bookmarks (clearing accounts) and saved searches ──────────

function Saved({ touch, onNavigate }: Props) {
  const periodHref = usePeriodHref()
  const pathname = usePathname()
  const sp = useSearchParams()
  const { sidebar } = useResolvedUIConfig()
  const { isPending } = useUIConfig()
  const bs = useBalanceSheet()
  const onJournal = pathname.startsWith("/journal")
  const account = sp.get("account") ?? ""
  const q = sp.get("q") ?? ""

  return (
    <>
      {(isPending || sidebar.bookmarks.length > 0) && (
        <ExtraLabel touch={touch}>Bookmarks</ExtraLabel>
      )}
      <div className="flex flex-col gap-0.5">
        {isPending && <Skeletons n={4} touch={touch} />}
        {sidebar.bookmarks.map((b) => {
          const node = find(bs.data?.trees[b.root], b.accountPath)
          const v = total(node)
          return (
            <ExtraRow
              key={b.id}
              href={periodHref(
                `/journal?account=${encodeURIComponent(b.accountPath)}`
              )}
              label={b.label}
              value={bs.data ? money(v) : undefined}
              valueTone={Math.round(v) < 0 ? "neg" : undefined}
              leading={<AccountDot root={b.root} />}
              active={onJournal && account === b.accountPath}
              touch={touch}
              onNavigate={onNavigate}
            />
          )
        })}
      </div>
      <ExtraLabel touch={touch}>Saved searches</ExtraLabel>
      <ExtraRow
        href={periodHref("/journal?q=tag:forecast")}
        label="Forecast entries"
        leading={<Bookmark size={13} />}
        active={onJournal && q === "tag:forecast"}
        touch={touch}
        onNavigate={onNavigate}
      />
    </>
  )
}

// ── Home + Planning: what's coming from the plan grid ───────────────────

interface Upcoming {
  key: string
  date: string
  label: string
  amount: number
}

function useUpcoming(): {
  items: Upcoming[] | null
  cards: Upcoming[] | null
  todo: number
} {
  const grid = usePlanGrid()
  return React.useMemo(() => {
    const d = grid.data
    if (!d) return { items: null, cards: null, todo: 0 }
    const items: Upcoming[] = []
    for (const row of d.rows) {
      if (row.date < d.today) continue
      for (const [bank, list] of Object.entries(row.entries)) {
        for (const [i, e] of list.entries()) {
          if (e.kind === "cleared") continue
          items.push({
            key: `${row.date}-${bank}-${i}`,
            date: row.date,
            label: e.description || bank.split(":").pop() || bank,
            amount: Number(e.amount),
          })
        }
      }
    }
    const cards = d.floatingProjections
      .filter((p) => p.date >= d.today)
      .map((p, i) => ({
        key: `cc-${i}`,
        date: p.date,
        label: p.displayName,
        amount: -Math.abs(Number(p.amount)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
    return { items, cards, todo: d.todoCount }
  }, [grid.data])
}

function UpcomingList({
  label,
  items,
  touch,
  onNavigate,
  n = 4,
}: {
  label: string
  items: Upcoming[] | null
  n?: number
} & Props) {
  const periodHref = usePeriodHref()
  return (
    <>
      <ExtraLabel touch={touch}>{label}</ExtraLabel>
      <div className="flex flex-col gap-0.5">
        {!items ? (
          <Skeletons n={3} touch={touch} />
        ) : items.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Nothing scheduled in Plan.
          </p>
        ) : (
          items
            .slice(0, n)
            .map((u) => (
              <ExtraRow
                key={u.key}
                href={periodHref("/plan")}
                label={u.label}
                sub={formatRelativeDate(u.date)}
                value={money(u.amount)}
                valueTone={u.amount < 0 ? "neg" : undefined}
                touch={touch}
                onNavigate={onNavigate}
              />
            ))
        )}
      </div>
    </>
  )
}

interface Props {
  touch?: boolean
  onNavigate?: () => void
}

export function SectionExtras({
  sectionId,
  ...props
}: { sectionId: string } & Props) {
  const up = useUpcoming()
  if (sectionId === "home")
    return <UpcomingList label="Coming up" items={up.items} {...props} />
  if (sectionId === "accounts") return <AccountGroups {...props} />
  if (sectionId === "activity") return <Saved {...props} />
  if (sectionId === "planning")
    return (
      <UpcomingList label="Card payments" items={up.cards} n={5} {...props} />
    )
  return null
}

/** Count badge for a page row (Plan's open to-dos). */
export function usePageBadge(): (href: string) => number | null {
  const up = useUpcoming()
  return (href) => (href === "/plan" && up.todo > 0 ? up.todo : null)
}
