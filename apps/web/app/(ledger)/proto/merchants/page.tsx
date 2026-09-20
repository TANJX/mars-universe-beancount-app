"use client"

// PROTOTYPE harness — merchant-icon audit board.
//
// Renders every distinct payee in the ledger through the real
// `resolveMerchant` pipeline + `MerchantAvatar`, grouped by resolution
// stage, so a whole year of icons can be eyeballed at once instead of
// scrolling the journal a month at a time.
//
// Nothing in the app imports from here. Delete with the rest of
// app/(ledger)/proto/ once the icon work lands.
//
//   ?from=2024-01-01&to=2026-12-31   time window (defaults to last 3y)
//   ?k=logo|category-icon|initial|glyph   filter to one resolution kind

import { useQueryState } from "nuqs"
import * as React from "react"

import {
  AVATAR_SIZES,
  MerchantAvatar,
} from "@/components/primitives/merchant-avatar"
import { useJournal } from "@/hooks/use-fava"
import { useResolvedUIConfig } from "@/lib/config"
import { resolveMerchant } from "@/lib/merchants/resolve"
import { classifyAll } from "@/lib/transform/classify"
import type { JournalRow } from "@/lib/types/views"
import { cn } from "@/lib/utils"

type Kind = "logo" | "category-icon" | "initial" | "glyph"

const KIND_LABEL: Record<Kind, string> = {
  logo: "Logo (brand matched)",
  "category-icon": "Category icon (payee missed, account hit)",
  initial: "Letter mark (nothing matched)",
  glyph: "Class glyph (transfer / forecast / investment / …)",
}

const KIND_BLURB: Record<Kind, string> = {
  logo: "Registry hit with a logo.dev domain. The good case.",
  "category-icon":
    "Stage 4.5. Generic per-category icon — every restaurant looks identical.",
  initial: "Stage 5. Hashed colour + first letters. The worst case.",
  glyph: "Stage 1. Intentionally non-brand; judge these on legibility only.",
}

interface Bucket {
  key: string
  kind: Kind
  /** What the resolver ended up calling it. */
  alt: string
  /** Raw payee as it appears in the ledger. */
  payee: string
  /** For category-icon: the lucide name that fired. */
  iconName?: string
  count: number
  accounts: Map<string, number>
  sample: JournalRow
}

export default function MerchantProtoPage() {
  const [from] = useQueryState("from")
  const [to] = useQueryState("to")
  const [kindFilter, setKindFilter] = useQueryState("k", {
    history: "replace",
  })
  const [q, setQ] = React.useState("")

  const today = new Date().toISOString().slice(0, 10)
  const start = from ?? `${new Date().getFullYear() - 2}-01-01`
  const end = to ?? today
  const time = `${start} - ${end}`

  const {
    data: txns,
    isPending,
    isError,
    error,
  } = useJournal({
    timeOverride: time,
  })

  const ui = useResolvedUIConfig()

  const buckets = React.useMemo<Bucket[]>(() => {
    if (!txns) return []
    const rows = classifyAll(txns)
    const map = new Map<string, Bucket>()
    for (const row of rows) {
      const resolved = resolveMerchant({
        row,
        size: AVATAR_SIZES.lg,
        registry: ui.merchants,
        accounts: ui.accounts,
      })
      const payee = (row.txn.payee ?? "").trim()
      const kind = resolved.kind as Kind
      const iconName =
        resolved.kind === "category-icon" ? resolved.name : undefined
      // One bucket per (kind, what-the-user-sees). Distinct payees that
      // collapse to the same icon are exactly what we want to see collapsed.
      const key =
        kind === "glyph"
          ? `glyph:${resolved.alt}`
          : kind === "category-icon"
            ? `cat:${iconName}:${payee.toLowerCase()}`
            : `${kind}:${resolved.alt}:${payee.toLowerCase()}`
      let b = map.get(key)
      if (!b) {
        b = {
          key,
          kind,
          alt: resolved.alt,
          payee,
          iconName,
          count: 0,
          accounts: new Map(),
          sample: row,
        }
        map.set(key, b)
      }
      b.count += 1
      const acct = row.category?.account ?? row.primary?.account ?? "—"
      b.accounts.set(acct, (b.accounts.get(acct) ?? 0) + 1)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [txns, ui.merchants, ui.accounts])

  const visible = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    return buckets.filter((b) => {
      if (kindFilter && b.kind !== kindFilter) return false
      if (!needle) return true
      return (
        b.payee.toLowerCase().includes(needle) ||
        b.alt.toLowerCase().includes(needle) ||
        (b.iconName ?? "").includes(needle) ||
        [...b.accounts.keys()].some((a) => a.toLowerCase().includes(needle))
      )
    })
  }, [buckets, kindFilter, q])

  const stats = React.useMemo(() => {
    const byKind = new Map<Kind, { buckets: number; txns: number }>()
    for (const b of buckets) {
      const s = byKind.get(b.kind) ?? { buckets: 0, txns: 0 }
      s.buckets += 1
      s.txns += b.count
      byKind.set(b.kind, s)
    }
    return byKind
  }, [buckets])

  const totalTxns = buckets.reduce((s, b) => s + b.count, 0)

  const groups: Kind[] = kindFilter
    ? [kindFilter as Kind]
    : ["initial", "category-icon", "logo", "glyph"]

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-16">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl tracking-tight">
          Merchant icon audit
        </h1>
        <p className="text-muted-foreground text-sm">
          {time} · {totalTxns.toLocaleString()} txns · {buckets.length} distinct
          icons
        </p>
      </header>

      {/* Coverage bar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setKindFilter(null)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs transition-colors",
            !kindFilter ? "bg-foreground text-background" : "hover:bg-muted"
          )}
        >
          All
        </button>
        {(["initial", "category-icon", "logo", "glyph"] as Kind[]).map((k) => {
          const s = stats.get(k)
          if (!s) return null
          const pct = totalTxns ? Math.round((s.txns / totalTxns) * 100) : 0
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(kindFilter === k ? null : k)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                kindFilter === k
                  ? "bg-foreground text-background"
                  : "hover:bg-muted"
              )}
            >
              {k} · {s.buckets} · {pct}%
            </button>
          )
        })}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter payee / account / icon name…"
          className="ml-auto h-7 w-72 rounded-md border bg-transparent px-2.5 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {isError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}
      {isPending && (
        <div className="text-muted-foreground text-sm">Loading ledger…</div>
      )}

      {groups.map((k) => {
        const items = visible.filter((b) => b.kind === k)
        if (!items.length) return null
        return (
          <section key={k} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2 pt-4">
              <h2 className="font-medium text-base">{KIND_LABEL[k]}</h2>
              <span className="text-muted-foreground text-xs">
                {items.length} · {KIND_BLURB[k]}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
              {items.map((b) => (
                <BucketCard key={b.key} bucket={b} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function BucketCard({ bucket }: { bucket: Bucket }) {
  const topAccounts = [...bucket.accounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-md border bg-card px-3 py-2.5">
      <MerchantAvatar row={bucket.sample} size="lg" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate font-medium text-sm" title={bucket.payee}>
          {bucket.payee || (
            <span className="text-muted-foreground italic">(no payee)</span>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {bucket.iconName ? `${bucket.iconName} · ` : ""}
          {topAccounts.map(([a]) => a.replace(/^Expenses:/, "")).join(", ")}
        </div>
      </div>
      <div className="ml-auto shrink-0 tabular-nums text-muted-foreground text-xs">
        {bucket.count}
      </div>
    </div>
  )
}
