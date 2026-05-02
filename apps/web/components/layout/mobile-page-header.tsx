"use client"

import * as React from "react"

interface MobilePageHeaderProps {
  title: string
  sub?: string
  right?: React.ReactNode
}

// Per-page header for the mobile shell: large page title + small mono
// sub-line on the left, slot for an action (typically MobilePeriodControl)
// on the right. Bracketed by safe-area inset on top.
export function MobilePageHeader({ title, sub, right }: MobilePageHeaderProps) {
  return (
    <header
      className="flex items-end justify-between gap-3 px-5 pb-3"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div>
        <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
        {sub && (
          <div className="font-mono text-xs text-muted-foreground tabular-nums">
            {sub}
          </div>
        )}
      </div>
      {right}
    </header>
  )
}
