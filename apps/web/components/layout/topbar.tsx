"use client"

import { usePathname } from "next/navigation"

import { PeriodCommand } from "@/components/filters/period-command"
import { ClientOnly } from "@/components/primitives/client-only"

export function Topbar() {
  const pathname = usePathname()
  if (pathname === "/plan" || pathname?.startsWith("/plan/")) return null
  return (
    <div className="flex shrink-0 items-center gap-3 px-4 py-3">
      <ClientOnly
        fallback={
          <div
            aria-hidden
            className="flex items-center"
            style={{ height: "2.125rem" }}
          />
        }
      >
        <PeriodCommand />
      </ClientOnly>
      <div className="flex-1" />
    </div>
  )
}
