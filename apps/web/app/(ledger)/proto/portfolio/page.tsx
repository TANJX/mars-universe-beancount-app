"use client"

// PROTOTYPE harness — three directions for the Portfolio page, on mock data.
// Nothing in the app imports from this directory. Delete the whole
// app/(ledger)/proto/ tree once a direction is chosen.
//
// Lives inside the (ledger) route group on purpose: the real sidebar, topbar,
// period chip and density wrapper are the surrounding context these layouts
// have to survive, and faking them would make the comparison a lie.

import { useQueryState } from "nuqs"
import * as React from "react"

import { ProtoPicker } from "./picker"
import "./proto.css"
import { AdvisorVariant } from "./variants/advisor"
import { DashboardVariant } from "./variants/dashboard"
import { LedgerVariant } from "./variants/ledger"

const VARIANTS = [
  { name: "Ledger", render: () => <LedgerVariant /> },
  { name: "Dashboard", render: () => <DashboardVariant /> },
  { name: "Advisor", render: () => <AdvisorVariant /> },
]

export default function ProtoPortfolioPage() {
  const [raw, setRaw] = useQueryState("v", { history: "replace" })
  const parsed = Number.parseInt(raw ?? "1", 10)
  const current =
    Number.isFinite(parsed) && parsed >= 1 && parsed <= VARIANTS.length
      ? parsed - 1
      : 0

  // Bumping the key re-mounts the variant so entrance state re-runs.
  const [nonce, setNonce] = React.useState(0)

  const select = React.useCallback(
    (i: number) => {
      setRaw(String(i + 1))
      setNonce((n) => n + 1)
    },
    [setRaw]
  )

  const replay = React.useCallback(() => setNonce((n) => n + 1), [])

  return (
    <div className="proto-scope">
      <React.Fragment key={`${current}-${nonce}`}>
        {VARIANTS[current].render()}
      </React.Fragment>
      <ProtoPicker
        names={VARIANTS.map((v) => v.name)}
        current={current}
        onSelect={select}
        onReplay={replay}
      />
    </div>
  )
}
