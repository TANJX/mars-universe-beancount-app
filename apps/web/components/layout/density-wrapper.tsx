"use client"

import { useUIState } from "@/components/layout/ui-state"

// Thin client wrapper that publishes the current density as a data-attribute
// on a `group/density` ancestor. Consumers apply compact heights via
// `group-data-[density=compact]/density:h-<size>` without themselves needing
// "use client".
export function DensityWrapper({ children }: { children: React.ReactNode }) {
  const { density } = useUIState()
  return (
    <div data-density={density} className="group/density contents">
      {children}
    </div>
  )
}
