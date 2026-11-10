"use client"

import {
  BarChart3,
  BookOpen,
  CalendarClock,
  Flame,
  LayoutGrid,
  ListTree,
  PanelLeft,
  PieChart,
  Receipt,
  Search,
  Settings2,
  Waypoints,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import type * as React from "react"
import { useCommandPalette } from "@/components/layout/command-palette"
import { useShortcutsDialog } from "@/components/layout/shortcuts-dialog"
import { usePeriodHref, useUIState } from "@/components/layout/ui-state"
import { AccountDot } from "@/components/primitives/account-dot"
import { ClientOnly } from "@/components/primitives/client-only"
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
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { useResolvedUIConfig, useUIConfig } from "@/lib/config"
import type { Density } from "@/lib/types/views"
import { cn } from "@/lib/utils"
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
  { href: "/portfolio", label: "Portfolio", icon: PieChart },
  { href: "/fire", label: "FIRE", icon: Flame },
  { href: "/runway", label: "Runway", icon: Waypoints },
  { href: "/income", label: "Income", icon: BarChart3 },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/journal", label: "Journal", icon: BookOpen },
]

// Shared by the parts of the sidebar that only exist in one state. They fade
// on the provider's timing: out first on collapse, in last on expand.
const EXPANDED_ONLY =
  "transition-opacity delay-(--sidebar-fade) duration-(--sidebar-fade) group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0"
const COLLAPSED_ONLY =
  "opacity-0 transition-opacity duration-(--sidebar-fade) group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-(--sidebar-fade)"

export function AppSidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const periodHref = usePeriodHref()
  const activeAccount = searchParams.get("account") ?? ""
  const { openCommandPalette } = useCommandPalette()
  const { branding, sidebar } = useResolvedUIConfig()
  const { isPending } = useUIConfig()
  const { open, toggleSidebar } = useSidebar()

  return (
    <Sidebar
      collapsible="icon"
      // The app separates sidebar and content with space, not a rule.
      className="group-data-[side=left]:border-r-0"
    >
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1 py-1">
          <span className="shrink-0">
            <MarsLogo />
          </span>
          <div
            className={cn(
              "min-w-0 flex-1 overflow-hidden leading-tight whitespace-nowrap",
              EXPANDED_ONLY
            )}
          >
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

        {/* px-[7px] + the 1px border keeps the icon on the same axis as the
            nav icons below, so it stays centered in the collapsed rail. */}
        <SidebarMenuButton
          type="button"
          onClick={openCommandPalette}
          tooltip={{ children: <TooltipLabel label="Search" keys="⌘K" /> }}
          className="cursor-pointer border bg-background px-[7px] text-muted-foreground"
        >
          <Search />
          <span className="flex flex-1 items-center gap-2">
            <span className="flex-1 truncate">Search</span>
            <kbd className="font-mono text-xs text-muted-foreground/80">⌘K</kbd>
          </span>
        </SidebarMenuButton>
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
                      tooltip={item.label}
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
                        <div className="flex h-7 items-center gap-2 px-2">
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <Skeleton className="size-2 rounded-full" />
                          </span>
                          <Skeleton className={cn("h-3 w-16", EXPANDED_ONLY)} />
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
                            tooltip={b.label}
                          >
                            {/* Bookmarks have no icon. The dot sits in the
                                same 16px slot as the nav icons; collapsed, a
                                monogram takes its place so the rail is not a
                                column of identical dots. */}
                            <span
                              aria-hidden
                              className="relative flex size-4 shrink-0 items-center justify-center"
                            >
                              <AccountDot
                                root={b.root}
                                className={EXPANDED_ONLY}
                              />
                              <span
                                className={cn(
                                  "absolute inset-0 flex items-center justify-center rounded-sm bg-sidebar-foreground/10 text-[10px] leading-none font-medium",
                                  COLLAPSED_ONLY
                                )}
                              >
                                {monogram(b.label)}
                              </span>
                            </span>
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

      <SidebarFooter className="gap-0">
        <ClientOnly fallback={<div aria-hidden style={{ height: "2rem" }} />}>
          <SettingsMenu />
        </ClientOnly>
        <SidebarMenuButton
          type="button"
          aria-expanded={open}
          // detail is 0 when the click came from Enter/Space: keyboard
          // toggles skip the animation, same as ⌘B.
          onClick={(e) => toggleSidebar({ instant: e.detail === 0 })}
          tooltip={{
            children: <TooltipLabel label="Expand sidebar" keys="⌘B" />,
          }}
          className="cursor-pointer text-muted-foreground"
        >
          <PanelLeft />
          <span className="flex flex-1 items-center gap-2">
            <span className="flex-1 truncate">
              {open ? "Collapse sidebar" : "Expand sidebar"}
            </span>
            <kbd className="font-mono text-xs text-muted-foreground/80">⌘B</kbd>
          </span>
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  )
}

function monogram(label: string): string {
  return Array.from(label.trim())[0]?.toUpperCase() ?? "?"
}

function TooltipLabel({ label, keys }: { label: string; keys: string }) {
  return (
    <>
      {label}
      <kbd className="font-mono text-background/60">{keys}</kbd>
    </>
  )
}

function SettingsMenu() {
  const { density, setDensity } = useUIState()
  const { theme = "system", setTheme } = useTheme()
  const { openShortcuts } = useShortcutsDialog()

  return (
    <DropdownMenu>
      <SidebarMenuButton
        render={<DropdownMenuTrigger />}
        tooltip="Display settings"
        className="cursor-pointer text-muted-foreground"
      >
        <Settings2 />
        <span>Display settings</span>
      </SidebarMenuButton>
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
  )
}
