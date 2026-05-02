"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { AlertCircle, Search, X } from "lucide-react"

import { JournalEntry } from "@/components/journal/journal-entry"
import { MobileJournal } from "@/components/journal/mobile/mobile-journal"
import { Tag } from "@/components/primitives/tag"
import { MobileJournalSkeleton } from "@/components/skeletons/journal-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import { useUIState } from "@/components/layout/ui-state"
import { useJournal } from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAccountOpeningBalance } from "@/hooks/use-opening-balance"
import { accountSegment } from "@/lib/transform/classify"
import {
  applySearch,
  isQueryEmpty,
  parseSearch,
  pickPrimaryAccount,
  stringifySearch,
} from "@/lib/search/parse"
import type { Posting } from "@/lib/types/beancount"
import { cn } from "@/lib/utils"

const COLS_BASE = "grid-cols-[5.5rem_1rem_1fr_9rem]"
const COLS_FILTERED = "grid-cols-[5.5rem_1rem_1fr_9rem_7rem_7rem]"

function readUrl(): { account: string; q: string } {
  if (typeof window === "undefined") return { account: "", q: "" }
  const sp = new URLSearchParams(window.location.search)
  return { account: sp.get("account") ?? "", q: sp.get("q") ?? "" }
}

export default function JournalPage() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // SSR-safe: empty initial state, then sync from URL on mount and whenever
  // the URL changes from outside (Link click on a bookmark, ⌘K palette nav,
  // browser back/forward). State is the source of truth for in-page edits.
  const [account, setAccount] = React.useState("")
  const [q, setQ] = React.useState("")
  const [hydrated, setHydrated] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  React.useEffect(() => setDraft(q), [q])

  // Track the last URL we wrote so we don't re-sync our own writes.
  const lastWrittenRef = React.useRef<string>("")

  // URL → state. Runs on mount and on every searchParams change. Skips when
  // the URL matches what we just wrote ourselves (to avoid races).
  const spStr = searchParams.toString()
  React.useEffect(() => {
    if (hydrated && spStr === lastWrittenRef.current) return
    const u = readUrl()
    setAccount(u.account)
    setQ(u.q)
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spStr])

  // State → URL. history.replaceState bypasses Next's router (which would
  // race setState during transitions) but still updates the address bar so
  // reload / share works.
  React.useEffect(() => {
    if (!hydrated) return
    const params = new URLSearchParams()
    if (account) params.set("account", account)
    if (q) params.set("q", q)
    const qs = params.toString()
    const target = qs ? `${pathname}?${qs}` : pathname
    if (target !== window.location.pathname + window.location.search) {
      lastWrittenRef.current = qs
      window.history.replaceState(null, "", target)
    }
  }, [hydrated, pathname, account, q])

  const { period } = useUIState()

  // Combine URL `account=` with whatever account: terms are inside `q` so
  // they share one parse pipeline. The URL-level account is what we send to
  // Fava (server-side hierarchical match); extra terms are client-filtered.
  const parsed = React.useMemo(() => {
    const base = parseSearch(q)
    if (account && !base.accounts.includes(account)) {
      base.accounts.unshift(account)
    }
    return base
  }, [q, account])

  const primaryAccount = pickPrimaryAccount(parsed)

  const {
    data: txns,
    isPending,
    isError,
    error,
  } = useJournal({ account: primaryAccount || undefined })

  // Fava returns the journal in chronological ascending order, with
  // intra-day items in file order (oldest write first). Reversing gives
  // us "newest first" + "newest within day = last write of that day at
  // the top" — which is what makes the cumulative column match fava's
  // current-balance number on the topmost row.
  const filteredAsc = React.useMemo(() => {
    if (!txns) return []
    return applySearch(txns, parsed)
  }, [txns, parsed])
  const filteredAndSorted = React.useMemo(
    () => [...filteredAsc].reverse(),
    [filteredAsc]
  )

  const accountFilter = primaryAccount || ""
  const colsClass = accountFilter ? COLS_FILTERED : COLS_BASE
  const isMobile = useIsMobile()

  // Mirror fava's clamp() semantics for the cumulative column: Assets /
  // Liabilities / Equity get an opening-balance seed at period start so
  // the running total carries history; Income / Expenses start from zero
  // (fava sweeps prior periods into retained earnings).
  const openingSeed = useAccountOpeningBalance(accountFilter || undefined)

  // Cumulative USD running balance for matching postings, computed in
  // chronological order (oldest → newest), then mapped back per txn.id
  // for render. The asc list is what fava returned, so the LAST entry
  // here is also the TOP entry in the desc display — its running total
  // is the account's current balance, matching fava.
  const cumulative = React.useMemo(() => {
    if (!accountFilter) return new Map<string, number>()
    const m = new Map<string, number>()
    let running = openingSeed
    for (const t of filteredAsc) {
      const matching = t.postings.filter((p) =>
        p.account.startsWith(accountFilter)
      )
      const usd = matching.reduce((s, p) => s + postingToUSD(p), 0)
      running += usd
      m.set(t.id, running)
    }
    return m
  }, [filteredAsc, accountFilter, openingSeed])

  function commit(value: string) {
    setQ(value)
  }

  function clearAccount() {
    const clean = parseSearch(q)
    clean.accounts = []
    clean.excludeAccounts = []
    setAccount("")
    setQ(stringifySearch(clean))
  }

  if (isMobile) {
    return (
      <>
        {isError && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">Couldn&apos;t load journal</div>
              <div className="text-xs text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </div>
            </div>
          </div>
        )}
        {isPending ? (
          <MobileJournalSkeleton />
        ) : (
          <MobileJournal
            period={period}
            rows={filteredAndSorted}
            totalCount={txns?.length ?? 0}
            accountFilter={accountFilter || undefined}
            cumulative={accountFilter ? cumulative : undefined}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-5 pb-10">
      <header>
        <div className="text-xl font-medium tracking-tight">Journal</div>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
          {filteredAndSorted.length} of {txns?.length ?? 0} · {period.range}
        </div>
      </header>

      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load journal</div>
            <div className="text-xs text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
        <Search size={14} className="shrink-0 text-muted-foreground" />
        {accountFilter && (
          <Tag tone="accent" size="sm" className="gap-1">
            <span>account:{accountSegment(accountFilter)}</span>
            <button
              type="button"
              onClick={clearAccount}
              aria-label="Remove account filter"
              className="text-current/60 hover:text-current"
            >
              <X size={10} />
            </button>
          </Tag>
        )}
        {parsed.tags.map((t) => (
          <Tag key={`tag-${t}`} tone="neutral" size="sm">
            #{t}
          </Tag>
        ))}
        {parsed.payees.map((p) => (
          <Tag key={`payee-${p}`} tone="neutral" size="sm">
            payee:{p}
          </Tag>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit(draft)
            }
            if (e.key === "Escape") {
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          onBlur={() => commit(draft)}
          placeholder="Search… try account:Expenses:Restaurants  payee:Tesla  tag:trip-2025-04-japan"
          className="min-w-36 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          data-search="primary"
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
          {filteredAndSorted.length} txns
        </span>
      </div>

      <div
        className={cn(
          "grid gap-3 px-7 text-xs font-medium tracking-wide text-muted-foreground uppercase",
          colsClass
        )}
      >
        <span>Date</span>
        <span />
        <span>Payee / Posting</span>
        <span className="text-right">Amount</span>
        {accountFilter && (
          <>
            <span className="text-right">
              Δ {accountSegment(accountFilter)}
            </span>
            <span className="text-right">Σ USD</span>
          </>
        )}
      </div>

      {isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card
              key={i}
              className="gap-0 overflow-hidden rounded-md border bg-card p-0"
            >
              <div
                className={cn("grid h-11 items-center gap-3 px-7", colsClass)}
              >
                <Skeleton className="h-3 w-12" />
                <span className="size-3" />
                <div className="flex items-center gap-2">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <span />
                {accountFilter && (
                  <>
                    <Skeleton className="h-3 w-16 justify-self-end" />
                    <Skeleton className="h-3 w-16 justify-self-end" />
                  </>
                )}
              </div>
              {Array.from({ length: 3 }).map((_, j) => (
                <div
                  key={j}
                  className={cn(
                    "grid h-7 items-center gap-3 pr-7 pl-[1.625rem]",
                    colsClass
                  )}
                >
                  <span />
                  <span />
                  <Skeleton className="h-2.5 w-1/2 opacity-70" />
                  <Skeleton className="h-2.5 w-20 justify-self-end opacity-70" />
                  {accountFilter && (
                    <>
                      <span />
                      <span />
                    </>
                  )}
                </div>
              ))}
            </Card>
          ))}
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState hasFilter={!isQueryEmpty(parsed)} />
      ) : (
        <div className="flex flex-col gap-2">
          {filteredAndSorted.map((txn) => (
            <JournalEntry
              key={txn.id}
              txn={txn}
              accountFilter={accountFilter}
              cumulativeUSD={
                accountFilter ? (cumulative.get(txn.id) ?? null) : null
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-sm text-muted-foreground">
        {hasFilter
          ? "No transactions match this filter."
          : "No transactions in this period."}
      </div>
      <div className="text-xs text-muted-foreground/70">
        Try widening the period (⌘P) or adjusting the search.
      </div>
    </div>
  )
}

function postingToUSD(p: Posting): number {
  if (p.amount.currency === "USD") return p.amount.number
  if (p.price?.currency === "USD") return p.amount.number * p.price.number
  if (p.cost?.currency === "USD") return p.amount.number * p.cost.number
  return 0
}
