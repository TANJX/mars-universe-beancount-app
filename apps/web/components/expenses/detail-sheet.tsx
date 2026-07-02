"use client"

import { X } from "lucide-react"

import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { formatPostingAmount } from "@/lib/format"
import type { ExpenseRowData } from "@/lib/transform/expense-row"
import { cn } from "@/lib/utils"

// In-page sheet, scoped to <main>. The sidebar stays interactive.
// Hand-rolled because shadcn's Sheet is viewport-fixed, which would also
// cover the sidebar — we want the sidebar visible.
export function ExpenseDetailSheet({
  row,
  onClose,
}: {
  row: ExpenseRowData
  onClose: () => void
}) {
  const { txn } = row.row

  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="pointer-events-auto flex-1 bg-black/30 backdrop-blur-[1px] dark:bg-black/40"
      />
      <aside
        className={cn(
          "w-[32rem] max-w-[80vw] bg-card text-card-foreground shadow-xl",
          "pointer-events-auto flex flex-col"
        )}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <MerchantAvatar row={row.row} size="lg" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-medium">
                {txn.payee || txn.narration || "Transaction"}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {txn.date}
                {txn.narration && txn.payee && (
                  <>
                    {" · "}
                    <span>&ldquo;{txn.narration}&rdquo;</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 p-1 text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 pb-5">
          <div className="pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Postings
          </div>
          <div className="flex flex-col gap-1">
            {txn.postings.map((p, i) => (
              <div
                key={`${p.account}-${i}`}
                className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-1"
              >
                <span className="truncate font-mono text-sm text-muted-foreground">
                  {p.account}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm tabular-nums",
                    p.amount.number < 0
                      ? "text-muted-foreground"
                      : "font-medium"
                  )}
                >
                  {formatPostingAmount(p)}
                </span>
              </div>
            ))}
          </div>

          {(txn.tags.length > 0 || txn.links.length > 0) && (
            <div className="flex flex-wrap gap-2 pt-4">
              {txn.tags.map((t) => (
                <span key={t} className="font-mono text-xs text-primary">
                  #{t}
                </span>
              ))}
              {txn.links.map((l) => (
                <span
                  key={l}
                  className="font-mono text-xs text-sky-500 dark:text-sky-400"
                >
                  ^{l}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
