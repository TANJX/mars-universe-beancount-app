"use client"

import { AlertCircle } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import * as React from "react"

import { AccountBalanceCard } from "@/components/journal/account-balance-card"
import { AllTimeFilterPrompt } from "@/components/journal/all-time-filter-prompt"
import { COLS_BASE, COLS_FILTERED } from "@/components/journal/cols"
import { JournalEntry } from "@/components/journal/journal-entry"
import { MobileJournal } from "@/components/journal/mobile/mobile-journal"
import { ShowMorePeriod } from "@/components/journal/show-more-period"
import { useUIState } from "@/components/layout/ui-state"
import { SearchBar } from "@/components/search/search-bar"
import { MobileJournalSkeleton } from "@/components/skeletons/journal-skeleton"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useJournal, useJournalOpenings } from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAccountOpeningBalance } from "@/hooks/use-opening-balance"
import { toFavaFilter } from "@/lib/search/fava-filter"
import {
  addToken,
  applySearch,
  hasToken,
  isQueryEmpty,
  parseSearch,
  pickPrimaryAccount,
  stringifySearch,
  type Token,
} from "@/lib/search/parse"
import { useSearchVocabulary } from "@/lib/search/vocabulary"
import { accountMatches, accountSegment } from "@/lib/transform/classify"
import { postingToUSD } from "@/lib/transform/parse-amount"
import { cn } from "@/lib/utils"

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

  // Track the last URL we wrote so we don't re-sync our own writes.
  const lastWrittenRef = React.useRef<string>("")

  // URL → state. Runs on mount and on every searchParams change. Skips when
  // the URL matches what we just wrote ourselves (to avoid races).
  const spStr = searchParams.toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hydrated` is deliberately omitted — re-sync only when the URL itself changes
  React.useEffect(() => {
    if (hydrated && spStr === lastWrittenRef.current) return
    const u = readUrl()
    setAccount(u.account)
    setQ(u.q)
    setHydrated(true)
  }, [spStr])

  // State → URL. history.replaceState bypasses Next's router (which would
  // race setState during transitions) but still updates the address bar so
  // reload / share works.
  React.useEffect(() => {
    if (!hydrated) return
    const params = new URLSearchParams(window.location.search)
    if (account) params.set("account", account)
    else params.delete("account")
    if (q) params.set("q", q)
    else params.delete("q")
    const qs = params.toString()
    const target = qs ? `${pathname}?${qs}` : pathname
    if (target !== window.location.pathname + window.location.search) {
      lastWrittenRef.current = qs
      window.history.replaceState(null, "", target)
    }
  }, [hydrated, pathname, account, q])

  const { period, setPeriod } = useUIState()

  // Combine URL `account=` with whatever account: terms are inside `q` so
  // they share one parse pipeline. The URL-level account is what we send to
  // Fava (server-side hierarchical match); extra terms also flow into
  // Fava's filter= so the wire payload shrinks server-side.
  const parsed = React.useMemo(() => {
    const base = parseSearch(q)
    if (account && !base.accounts.includes(account)) {
      base.accounts.unshift(account)
    }
    return base
  }, [q, account])

  const primaryAccount = pickPrimaryAccount(parsed)
  const favaFilter = React.useMemo(
    () => toFavaFilter(parsed, primaryAccount),
    [parsed, primaryAccount]
  )

  // "All time" with no narrowing token would pull the entire ledger. Gate
  // the fetch and prompt the user to add a filter. `excludeAccounts`
  // alone doesn't count — still needs the full payload to apply.
  const hasAnyNarrowingFilter =
    parsed.accounts.length > 0 ||
    parsed.links.length > 0 ||
    parsed.tags.length > 0 ||
    parsed.payees.length > 0 ||
    parsed.text.length > 0
  const requiresFilter = period.id === "all" && !hasAnyNarrowingFilter

  const journalOpts = {
    account: primaryAccount || undefined,
    filter: favaFilter,
    enabled: !requiresFilter,
  }
  const { data: txns, isPending, isError, error } = useJournal(journalOpts)
  // Same query key as above — a second view of one request, not a second
  // fetch. Carries the period-boundary opening balances Fava computed
  // *after* applying our `filter=`.
  const { data: openings } = useJournalOpenings(journalOpts)

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
  const hasNarrowingFilter =
    parsed.links.length > 0 ||
    parsed.tags.length > 0 ||
    parsed.payees.length > 0 ||
    parsed.text.length > 0 ||
    parsed.excludeAccounts.length > 0 ||
    parsed.accounts.length > 1

  // Two sources for that seed, because neither covers both cases:
  //
  //   unfiltered → the balance-sheet snapshot, which honours the at_value
  //     conversion (so investment lots seed at market value, matching the
  //     rest of the app) but accepts no `filter=`.
  //   filtered → the flag-'S' summarisation entries that came back with
  //     this very journal response. Fava applies `filter=` before
  //     summarising, so they are the pre-period balance of exactly the
  //     rows on screen. Without this the seed was hard-zeroed and the
  //     column silently dropped every pre-period posting the filter
  //     matched — e.g. `link:expensify-2026-08` under an August period
  //     lost the report's July-dated entries.
  const snapshotSeed = useAccountOpeningBalance(
    hasNarrowingFilter ? undefined : accountFilter || undefined
  )
  const filteredSeed = React.useMemo(() => {
    if (!accountFilter || !openings) return 0
    let sum = 0
    for (const [acct, usd] of Object.entries(openings)) {
      if (accountMatches(acct, accountFilter)) sum += usd
    }
    return sum
  }, [openings, accountFilter])
  const openingSeed = hasNarrowingFilter ? filteredSeed : snapshotSeed

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
        accountMatches(p.account, accountFilter)
      )
      const usd = matching.reduce((s, p) => s + postingToUSD(p), 0)
      // Round to cents each step so float drift can't accumulate into a
      // residual like -2e-13 — a zeroed-out account must read exactly 0.
      running = Math.round((running + usd) * 100) / 100
      m.set(t.id, running)
    }
    return m
  }, [filteredAsc, accountFilter, openingSeed])

  function clearAccount() {
    setAccount("")
  }

  // Click-to-filter from a journal entry's tag/link/account badge.
  // Accounts route to the URL primary (`?account=`) to match fava's
  // account-navigation semantics and the cmdK/sidebar entry points;
  // tags/links/etc. append a chip via the standard SearchQuery path.
  // No-op if the click would be a duplicate.
  const handleAddToken = React.useCallback(
    (token: Token) => {
      if (token.kind === "account") {
        if (account === token.value) return
        setAccount(token.value)
        return
      }
      if (hasToken(parsed, token)) return
      setQ(stringifySearch(addToken(parsed, token)))
    },
    [parsed, account]
  )

  const vocabulary = useSearchVocabulary(txns)

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
        {requiresFilter ? (
          <AllTimeFilterPrompt onResetPeriod={() => setPeriod("mtd")} />
        ) : isPending ? (
          <MobileJournalSkeleton />
        ) : (
          <MobileJournal
            period={period}
            rows={filteredAndSorted}
            totalCount={txns?.length ?? 0}
            accountFilter={accountFilter || undefined}
            hasOtherFilters={hasNarrowingFilter}
            cumulative={accountFilter ? cumulative : undefined}
            onAddToken={handleAddToken}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
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

      <SearchBar
        value={q}
        onChange={setQ}
        vocabulary={vocabulary}
        accountFilter={account || undefined}
        onClearAccount={account ? clearAccount : undefined}
        matchedCount={filteredAndSorted.length}
        totalCount={txns?.length ?? 0}
        countLabel="txns"
      />

      {/* Column headers belong over rows or their skeletons — not over the
          empty state or the account balance card, which have their own shape. */}
      {!requiresFilter && (isPending || filteredAndSorted.length > 0) && (
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
      )}

      {requiresFilter ? (
        <AllTimeFilterPrompt onResetPeriod={() => setPeriod("mtd")} />
      ) : isPending ? (
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
        accountFilter ? (
          <AccountBalanceCard
            account={accountFilter}
            hasOtherFilters={hasNarrowingFilter}
          />
        ) : (
          <EmptyState hasFilter={!isQueryEmpty(parsed)} />
        )
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {filteredAndSorted.map((txn) => (
              <JournalEntry
                key={txn.id}
                txn={txn}
                accountFilter={accountFilter}
                cumulativeUSD={
                  accountFilter ? (cumulative.get(txn.id) ?? null) : null
                }
                onAddToken={handleAddToken}
              />
            ))}
          </div>
          <div className="flex justify-center">
            <ShowMorePeriod />
          </div>
        </>
      )}
    </div>
  )
}

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex flex-col gap-1">
        <div className="text-sm text-muted-foreground">
          {hasFilter
            ? "No transactions match this filter."
            : "No transactions in this period."}
        </div>
        <div className="text-xs text-muted-foreground/70">
          Widen the period below (or ⌘P) or adjust the search.
        </div>
      </div>
      <ShowMorePeriod />
    </div>
  )
}
