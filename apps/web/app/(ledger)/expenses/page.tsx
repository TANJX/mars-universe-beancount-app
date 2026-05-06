"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { DailyChart } from "@/components/expenses/daily-chart"
import { ExpensesTable } from "@/components/expenses/expenses-table"
import { MobileExpenses } from "@/components/expenses/mobile/mobile-expenses"
import { Money } from "@/components/primitives/money"
import { SearchBar } from "@/components/search/search-bar"
import { MobileExpensesSkeleton } from "@/components/skeletons/expenses-skeleton"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useUIState } from "@/components/layout/ui-state"
import { useJournal } from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import { deriveExpenseRows } from "@/lib/transform/expense-row"
import {
  applySearch,
  isQueryEmpty,
  parseSearch,
  pickPrimaryAccount,
} from "@/lib/search/parse"
import { useSearchVocabulary } from "@/lib/search/vocabulary"

function readUrl(): { account: string; q: string } {
  if (typeof window === "undefined") return { account: "", q: "" }
  const sp = new URLSearchParams(window.location.search)
  return { account: sp.get("account") ?? "", q: sp.get("q") ?? "" }
}

export default function ExpensesPage() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // SSR-safe empty initial state, then sync from URL on mount and whenever
  // the URL changes from outside (Link click on a bookmark, ⌘K palette nav,
  // browser back/forward). State is the source of truth for in-page edits.
  const [account, setAccount] = React.useState("")
  const [q, setQ] = React.useState("")
  const [hydrated, setHydrated] = React.useState(false)

  // Track the last URL we wrote so we don't re-sync our own writes.
  const lastWrittenRef = React.useRef<string>("")

  // URL → state. Skips when the URL matches what we wrote ourselves.
  const spStr = searchParams.toString()
  React.useEffect(() => {
    if (hydrated && spStr === lastWrittenRef.current) return
    const u = readUrl()
    setAccount(u.account)
    setQ(u.q)
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spStr])

  // State → URL via history.replaceState (bypasses Next's router which would
  // race setState during transitions).
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

  const { period } = useUIState()

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

  const filtered = React.useMemo(() => {
    if (!txns) return []
    const matched = applySearch(txns, parsed)
    return deriveExpenseRows(matched)
  }, [txns, parsed])

  const totalSpent = filtered.reduce((s, r) => s + r.share, 0)
  const isMobile = useIsMobile()

  function clearAccount() {
    setAccount("")
  }

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
        {isPending ? (
          <MobileExpensesSkeleton />
        ) : (
          <MobileExpenses period={period} rows={filtered} />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xl font-medium tracking-tight">Expenses</div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
            {filtered.length} transactions · {period.range}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 leading-tight">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Total spent
          </span>
          <Money
            value={-totalSpent}
            tone="neg"
            className="text-2xl font-medium tracking-tight"
          />
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

      {!isPending && filtered.length > 0 && (
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground">
              Daily spend
            </span>
          </div>
          <div className="px-4 pb-4">
            <DailyChart rows={filtered} />
          </div>
        </Card>
      )}

      <SearchBar
        value={q}
        onChange={setQ}
        vocabulary={vocabulary}
        accountFilter={account || undefined}
        onClearAccount={account ? clearAccount : undefined}
        matchedCount={filtered.length}
        countLabel="rows"
      />

      {isPending ? (
        <div className="flex flex-col">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="grid h-11 items-center gap-3 border-b px-5"
              style={{
                gridTemplateColumns:
                  "4rem 1.75rem minmax(11rem, 1.6fr) 6.25rem minmax(7rem, 1fr) 6.875rem",
              }}
            >
              <Skeleton className="h-3 w-12" />
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16 justify-self-end" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <div className="text-sm text-muted-foreground">
            {!isQueryEmpty(parsed)
              ? "No expenses match this filter."
              : "No expenses in this period."}
          </div>
          <div className="text-xs text-muted-foreground/70">
            Try widening the period (⌘P) or adjusting the search.
          </div>
        </div>
      ) : (
        <ExpensesTable rows={filtered} />
      )}
    </div>
  )
}
