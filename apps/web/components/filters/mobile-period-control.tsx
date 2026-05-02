"use client"

import * as React from "react"

import { PeriodChip } from "@/components/filters/period-chip"
import { PeriodSheet } from "@/components/filters/period-sheet"

interface MobilePeriodControlProps {
  className?: string
}

export function MobilePeriodControl({ className }: MobilePeriodControlProps) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <PeriodChip onClick={() => setOpen(true)} className={className} />
      <PeriodSheet open={open} onOpenChange={setOpen} />
    </>
  )
}
