"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BarChart3,
  BookOpen,
  LayoutGrid,
  ListTree,
  Receipt,
} from "lucide-react"

import { cn } from "@/lib/utils"

interface TabItem {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

const TABS: TabItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutGrid },
  { href: "/balances", label: "Balances", icon: ListTree },
  { href: "/income", label: "Income", icon: BarChart3 },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/journal", label: "Journal", icon: BookOpen },
]

export function MobileTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 justify-around border-t bg-background px-3 pt-2.5"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {TABS.map((tab) => {
        const active =
          pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        const Icon = tab.icon
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-col items-center gap-1 px-3 py-1 text-[10.5px]",
              active
                ? "font-semibold text-primary"
                : "font-normal text-muted-foreground"
            )}
          >
            <Icon size={18} />
            <span>{tab.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
