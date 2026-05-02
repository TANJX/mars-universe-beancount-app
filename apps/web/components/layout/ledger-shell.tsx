"use client"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { CommandPalette } from "@/components/layout/command-palette"
import { DensityWrapper } from "@/components/layout/density-wrapper"
import { GlobalKeys } from "@/components/layout/global-keys"
import { MobileTabBar } from "@/components/layout/mobile-tab-bar"
import { Topbar } from "@/components/layout/topbar"
import { ClientOnly } from "@/components/primitives/client-only"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useChangedPoll } from "@/hooks/use-changed-poll"
import { useIsMobile } from "@/hooks/use-mobile"

// SSR + first paint show NoChromeShell (no sidebar, no tab bar). Once the
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
      <main className="min-h-0 flex-1 overflow-auto">
        <DensityWrapper>{children}</DensityWrapper>
      </main>
    </div>
  )
}

function MobileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <main className="min-h-0 flex-1 overflow-auto">
        <DensityWrapper>{children}</DensityWrapper>
      </main>
      <MobileTabBar />
    </div>
  )
}

function DesktopShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider className="h-svh">
      <CommandPalette>
        <AppSidebar />
        <SidebarInset className="flex flex-col overflow-hidden">
          <Topbar />
          <main className="flex-1 overflow-auto">
            <DensityWrapper>{children}</DensityWrapper>
          </main>
        </SidebarInset>
        <GlobalKeys />
      </CommandPalette>
    </SidebarProvider>
  )
}
