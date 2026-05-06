"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  LayoutGrid,
  ListTree,
  Receipt,
  Search,
  Settings2,
} from "lucide-react"
import { useTheme } from "next-themes"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AccountDot } from "@/components/primitives/account-dot"
import { ClientOnly } from "@/components/primitives/client-only"
import { useCommandPalette } from "@/components/layout/command-palette"
import { useShortcutsDialog } from "@/components/layout/shortcuts-dialog"
import { usePeriodHref, useUIState } from "@/components/layout/ui-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useResolvedUIConfig, useUIConfig } from "@/lib/config"
import type { Density } from "@/lib/types/views"
import { MarsLogo } from "./mars-logo"

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; size?: number }>
}

const NAV_ITEMS: NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutGrid },
  { href: "/plan", label: "Plan", icon: CalendarClock },
  { href: "/balances", label: "Balances", icon: ListTree },
  { href: "/income", label: "Income", icon: BarChart3 },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/journal", label: "Journal", icon: BookOpen },
]

export function AppSidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const periodHref = usePeriodHref()
  const activeAccount = searchParams.get("account") ?? ""
  const { openCommandPalette } = useCommandPalette()
  const { branding, sidebar } = useResolvedUIConfig()
  const { isPending } = useUIConfig()

  return (
    <Sidebar collapsible="none">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1 py-1">
          <MarsLogo />
          <div className="min-w-0 flex-1 leading-tight">
            {isPending ? (
              <div className="flex flex-col gap-1 py-0.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            ) : (
              <>
                <div className="truncate text-sm font-semibold tracking-tight">
                  {branding.title}
                </div>
                {branding.subtitle && (
                  <div className="truncate text-xs text-muted-foreground">
                    {branding.subtitle}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={openCommandPalette}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <Search size={12} />
          <span className="flex-1 text-sm">Search</span>
          <kbd className="font-mono text-xs text-muted-foreground/80">⌘K</kbd>
        </button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`)
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={periodHref(item.href)} />}
                      isActive={active}
                    >
                      <Icon size={14} />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {(isPending || sidebar.bookmarks.length > 0) && (
          <SidebarGroup>
            <SidebarGroupLabel>Bookmarks</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {isPending
                  ? // Render placeholders sized like real bookmark rows so the
                    // sidebar doesn't reflow when the real data arrives.
                    Array.from({ length: 4 }).map((_, i) => (
                      <SidebarMenuItem key={i}>
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <Skeleton className="size-1.5 rounded-full" />
                          <Skeleton className="h-3 w-16" />
                        </div>
                      </SidebarMenuItem>
                    ))
                  : sidebar.bookmarks.map((b) => {
                      const href = periodHref(
                        `/journal?account=${encodeURIComponent(b.accountPath)}`
                      )
                      // Highlight only the bookmark whose account is the current
                      // filter — not every bookmark when on /journal.
                      const active =
                        pathname.startsWith("/journal") &&
                        activeAccount === b.accountPath
                      return (
                        <SidebarMenuItem key={b.id}>
                          <SidebarMenuButton
                            size="sm"
                            render={<Link href={href} />}
                            isActive={active}
                          >
                            <AccountDot root={b.root} />
                            <span>{b.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <ClientOnly
          fallback={
            <div
              aria-hidden
              className="flex justify-start px-1"
              style={{ height: "1.75rem" }}
            />
          }
        >
          <SettingsMenu />
        </ClientOnly>
      </SidebarFooter>
    </Sidebar>
  )
}

function SettingsMenu() {
  const { density, setDensity } = useUIState()
  const { theme = "system", setTheme } = useTheme()
  const { openShortcuts } = useShortcutsDialog()

  return (
    <div className="flex justify-start px-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Display settings"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <Settings2 size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-auto min-w-44"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(v) => setTheme(v)}
            >
              <DropdownMenuRadioItem value="light">
                <span className="whitespace-nowrap">Light</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <span className="whitespace-nowrap">Dark</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <span className="whitespace-nowrap">System</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Row height</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={(v) => setDensity(v as Density)}
            >
              <DropdownMenuRadioItem value="comfortable">
                <span className="whitespace-nowrap">Comfortable</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="compact">
                <span className="whitespace-nowrap">Compact</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => {
              setTimeout(openShortcuts, 50)
            }}
          >
            <span className="whitespace-nowrap">Keyboard shortcuts</span>
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
