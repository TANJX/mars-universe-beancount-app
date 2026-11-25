"use client"

import * as React from "react"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { CommandPalette } from "@/components/layout/command-palette"
import { DensityWrapper } from "@/components/layout/density-wrapper"
import { GlobalKeys } from "@/components/layout/global-keys"
import { MobileNavHeader } from "@/components/layout/mobile-nav"
import { Topbar } from "@/components/layout/topbar"
import { ClientOnly } from "@/components/primitives/client-only"
import { SidebarProvider } from "@/components/ui/sidebar"
import { useChangedPoll } from "@/hooks/use-changed-poll"
import { useIsMobile } from "@/hooks/use-mobile"

// SSR + first paint show NoChromeShell (no sidebar, no nav header). Once the
// client mounts we know the viewport class and swap to either MobileShell
// or DesktopShell. Both share the flex-column wrapper so swapping chrome
// in doesn't reflow the page body — avoids the desktop-shell flash on
// phones and the mobile-shell flash on desktop.
export function LedgerShell({ children }: { children: React.ReactNode }) {
  return (
    <ClientOnly fallback={<NoChromeShell>{children}</NoChromeShell>}>
      <ResolvedShell>{children}</ResolvedShell>
    </ClientOnly>
  )
}

function ResolvedShell({ children }: { children: React.ReactNode }) {
  // Mounted once per session (post-hydration via ClientOnly). Polls
  // /api/changed every 5s and invalidates React Query when fava reports
  // a ledger file edit — same mechanism fava's own UI uses.
  useChangedPoll()
  const isMobile = useIsMobile()
  return isMobile ? (
    <MobileShell>{children}</MobileShell>
  ) : (
    <DesktopShell>{children}</DesktopShell>
  )
}

function NoChromeShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <main className="relative min-h-0 flex-1 overflow-auto">
        <DensityWrapper>{children}</DensityWrapper>
      </main>
    </div>
  )
}

function MobileShell({ children }: { children: React.ReactNode }) {
  // CommandPalette here too: the header's search button opens it.
  return (
    <CommandPalette>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <MobileNavHeader />
        <main
          className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <DensityWrapper>{children}</DensityWrapper>
        </main>
      </div>
    </CommandPalette>
  )
}

const SIDEBAR_OPEN_KEY = "mars-sidebar-open"

function readStoredSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0"
  } catch {
    return true
  }
}

function DesktopShell({ children }: { children: React.ReactNode }) {
  // DesktopShell only ever mounts on the client (see LedgerShell), so the
  // stored state can be read synchronously for the very first render: the
  // sidebar appears already collapsed or expanded, never default-then-fixed.
  // localStorage rather than a cookie because no server render reads it.
  const [sidebarOpen, setSidebarOpen] = React.useState(readStoredSidebarOpen)
  const onSidebarOpenChange = React.useCallback((open: boolean) => {
    setSidebarOpen(open)
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0")
    } catch {
      // Storage unavailable (private mode): the toggle still works.
    }
  }, [])

  return (
    <SidebarProvider
      className="h-svh"
      open={sidebarOpen}
      onOpenChange={onSidebarOpenChange}
    >
      <CommandPalette>
        {/* AppSidebar draws the canvas + rail and wraps this page column in
            the raised card. SidebarProvider is kept for the open state and
            its ⌘B binding. */}
        <AppSidebar>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Topbar />
            {/* `relative` on every shell <main>: it makes the scroller the
                containing block for absolute descendants (sr-only spans),
                which otherwise escape it and stretch the window. */}
            <main className="relative min-h-0 flex-1 overflow-auto">
              <DensityWrapper>{children}</DensityWrapper>
            </main>
          </div>
        </AppSidebar>
        <GlobalKeys />
      </CommandPalette>
    </SidebarProvider>
  )
}
