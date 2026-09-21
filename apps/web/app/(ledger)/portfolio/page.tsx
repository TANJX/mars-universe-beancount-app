"use client"

// Holdings, allocation, contribution room and realized P/L across every
// investment sleeve. One request: `/api/ext/portfolio` returns the sleeves,
// the month-end value-vs-cost series, the realized totals and the
// contribution meters in a single round trip, because the series needs the
// server's price map anyway.
//
// Mobile is deliberately deferred — the mobile tab bar has no Portfolio entry
// and this page renders its desktop layout at every width for now.

import { AlertCircle } from "lucide-react"

import { PortfolioView } from "@/components/portfolio/portfolio-page"
import { PortfolioSkeleton } from "@/components/skeletons/portfolio-skeleton"
import { usePortfolio } from "@/hooks/use-portfolio"

export default function PortfolioPage() {
  const portfolio = usePortfolio()

  const errorMsg = portfolio.error
    ? portfolio.error instanceof Error
      ? portfolio.error.message
      : String(portfolio.error)
    : null

  if (errorMsg) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
        <header className="flex items-start justify-between gap-6">
          <h1 className="font-medium text-xl tracking-tight">Portfolio</h1>
        </header>
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load portfolio</div>
            <div className="text-muted-foreground text-xs">{errorMsg}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!portfolio.data) return <PortfolioSkeleton />

  return <PortfolioView portfolio={portfolio.data} />
}
