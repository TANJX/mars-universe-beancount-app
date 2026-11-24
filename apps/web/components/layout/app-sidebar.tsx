"use client"

// Desktop app shell: a section rail on the tinted canvas, and one raised
// card holding the section panel and the page. Two-level nav:
//   rail   - picks the section (returns to the last page used there)
//   panel  - the section's pages, each with a one-line hint, plus context
//            (account groups, bookmarks, upcoming plan items)
//   flyout - hovering (or → on) another section shows its panel floating,
//            so any page is one click away; with the panel hidden (⌘B)
//            the flyout is the main way around.
// Design record: docs/notes/2026-11-24-navigation-redesign.md

import { PanelLeft, PanelLeftClose, Search, Settings2 } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import * as React from "react"

import { useCommandPalette } from "@/components/layout/command-palette"
import { MarsLogo } from "@/components/layout/mars-logo"
import {
  isPageActive,
  NAV_SECTIONS,
  type NavSection,
  sectionFor,
} from "@/components/layout/nav"
import { useShortcutsDialog } from "@/components/layout/shortcuts-dialog"
import { SectionExtras, usePageBadge } from "@/components/layout/sidebar-extras"
import { usePeriodHref, useUIState } from "@/components/layout/ui-state"
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
import { useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useResolvedUIConfig } from "@/lib/config"
import type { Density } from "@/lib/types/views"
import { cn } from "@/lib/utils"

/** Hover dwell before the flyout opens, so sweeping across the rail
 * doesn't flash panels. */
const FLYOUT_OPEN_MS = 120
/** Grace period so the pointer can travel from the icon into the flyout. */
const FLYOUT_CLOSE_MS = 220
/** Panel header and the page Topbar share this height, so the section
 * title sits on the period picker's centre line. */
const HEADER_H = "h-[58px]"

export function AppSidebar({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { open } = useSidebar()
  const hrefFor = useLastPageInSection()
  const fly = useFlyout(pathname)
  const current = sectionFor(pathname)
  const flySection =
    fly.hovered && !(open && fly.hovered === current.id)
      ? NAV_SECTIONS.find((s) => s.id === fly.hovered)
      : undefined

  return (
    <div className="relative isolate flex h-svh w-full bg-(--canvas)">
      <Rail
        current={current}
        hrefFor={hrefFor}
        fly={fly}
        flyId={flySection?.id}
      />

      <div className="my-(--shell-inset) mr-(--shell-inset) flex min-w-0 flex-1 overflow-hidden rounded-(--shell-radius) bg-background shadow-(--elev-card)">
        {open && (
          <nav
            aria-label={`${current.label} pages`}
            className="flex w-(--panel-w) shrink-0 flex-col overflow-y-auto overscroll-contain border-r-(length:--hairline) border-r-border bg-sidebar px-2 pb-3"
          >
            <PanelBody section={current} />
          </nav>
        )}
        {children}
      </div>

      {flySection && (
        <div
          ref={fly.panelRef}
          role="dialog"
          aria-label={`${flySection.label} pages`}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault()
              fly.closeToRail()
            }
          }}
          onMouseEnter={fly.keep}
          onMouseLeave={fly.leave}
          className="nav-flyout absolute top-(--shell-inset) bottom-(--shell-inset) left-(--rail-w) z-10 flex w-(--panel-w) flex-col overflow-y-auto overscroll-contain rounded-(--shell-radius) bg-(--flyout-bg) px-2 pb-3 text-popover-foreground shadow-(--elev-flyout)"
        >
          <PanelBody section={flySection} onNavigate={fly.close} />
        </div>
      )}
    </div>
  )
}

/* ── Rail ──────────────────────────────────────────────────────────────── */

const RAIL_BUTTON =
  "flex size-10 items-center justify-center rounded-lg text-(--canvas-muted) transition-[background-color,color] duration-150 ease-out outline-none hover:bg-(--nav-hover) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

function RailButton({
  label,
  children,
  ...rest
}: {
  label: string
  children: React.ReactNode
} & React.ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={RAIL_BUTTON}
            {...rest}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function Rail({
  current,
  hrefFor,
  fly,
  flyId,
}: {
  current: NavSection
  hrefFor: (s: NavSection) => string
  fly: ReturnType<typeof useFlyout>
  flyId?: string
}) {
  const periodHref = usePeriodHref()
  const badge = usePageBadge()
  const { branding } = useResolvedUIConfig()
  const { openCommandPalette } = useCommandPalette()
  const { open, toggleSidebar } = useSidebar()

  return (
    <div className="relative z-20 flex w-(--rail-w) shrink-0 flex-col items-center pt-(--shell-inset)">
      <div
        className={cn("flex shrink-0 items-center justify-center", HEADER_H)}
      >
        <Link
          href={periodHref("/overview")}
          aria-label={branding.title}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MarsLogo />
        </Link>
      </div>
      <RailButton label="Search  ⌘K" onClick={openCommandPalette}>
        <Search size={18} />
      </RailButton>
      <nav
        aria-label="Sections"
        className="mt-3 flex flex-col items-center gap-1"
        onMouseLeave={fly.leave}
      >
        {NAV_SECTIONS.map((s) => {
          const Icon = s.icon
          const active = current.id === s.id
          const flying = flyId === s.id
          const dot = s.pages.some((p) => badge(p.href) !== null)
          return (
            <Link
              key={s.id}
              href={periodHref(hrefFor(s))}
              aria-current={active ? "page" : undefined}
              data-rail-section={s.id}
              onMouseEnter={() => fly.enter(s.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault()
                  fly.openNow(s.id)
                }
              }}
              className={cn(
                // Constant weight; state is carried by color and surface.
                "relative flex w-12 flex-col items-center gap-1 rounded-lg pt-2 pb-1.5 text-[10px] leading-none font-medium transition-[background-color,color,box-shadow,scale] duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]",
                active
                  ? "bg-background text-foreground shadow-(--elev-pill)"
                  : "text-(--canvas-muted) hover:bg-(--nav-hover) hover:text-foreground",
                flying && !active && "bg-(--nav-hover) text-foreground"
              )}
            >
              <Icon size={18} strokeWidth={active ? 2.1 : 1.8} />
              {s.label}
              {dot && (
                <span
                  role="img"
                  aria-label="Has to-dos"
                  className="absolute top-1.5 right-2.5 size-1.5 rounded-full bg-primary"
                />
              )}
            </Link>
          )
        })}
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1 pb-3">
        <ClientOnly fallback={<div aria-hidden className="size-10" />}>
          <SettingsMenu />
        </ClientOnly>
        <RailButton
          label={open ? "Hide panel  ⌘B" : "Show panel  ⌘B"}
          aria-expanded={open}
          // detail is 0 for Enter/Space: keyboard toggles skip animation.
          onClick={(e) => toggleSidebar({ instant: e.detail === 0 })}
        >
          {open ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
        </RailButton>
      </div>
    </div>
  )
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

/** Section title, page links (hint + badge), then section context. Used
 * by both the pinned panel and the flyout. */
function PanelBody({
  section,
  onNavigate,
}: {
  section: NavSection
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const periodHref = usePeriodHref()
  const badge = usePageBadge()
  return (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center px-2 text-[15px] font-semibold tracking-tight",
          HEADER_H
        )}
      >
        {section.label}
      </div>
      <div className="flex flex-col gap-0.5">
        {section.pages.map((p) => {
          const Icon = p.icon
          const active = isPageActive(pathname, p.href)
          const n = badge(p.href)
          return (
            <Link
              key={p.href}
              href={periodHref(p.href)}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-[background-color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-(--nav-current)" : "hover:bg-(--nav-hover)"
              )}
            >
              <Icon
                size={15}
                className={cn(
                  "shrink-0",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm leading-tight font-medium">
                  {p.label}
                </span>
                <span className="block truncate text-xs leading-tight text-muted-foreground">
                  {p.hint}
                </span>
              </span>
              {n !== null && (
                <span
                  role="img"
                  aria-label={`${n} to do`}
                  className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[11px] leading-none font-medium text-primary-foreground tabular-nums"
                >
                  {n}
                </span>
              )}
            </Link>
          )
        })}
      </div>
      <SectionExtras sectionId={section.id} onNavigate={onNavigate} />
    </>
  )
}

/* ── Flyout hover intent + keyboard ────────────────────────────────────── */

function useFlyout(pathname: string) {
  const [hovered, setHovered] = React.useState<string | null>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const wantFocus = React.useRef(false)
  const openT = React.useRef<number | undefined>(undefined)
  const closeT = React.useRef<number | undefined>(undefined)

  const keep = React.useCallback(() => {
    window.clearTimeout(openT.current)
    window.clearTimeout(closeT.current)
  }, [])
  const close = React.useCallback(() => {
    keep()
    setHovered(null)
  }, [keep])
  const enter = (id: string) => {
    keep()
    // Already open: switch sections instantly, no second dwell.
    if (hovered) setHovered(id)
    else openT.current = window.setTimeout(() => setHovered(id), FLYOUT_OPEN_MS)
  }
  const leave = () => {
    keep()
    closeT.current = window.setTimeout(() => setHovered(null), FLYOUT_CLOSE_MS)
  }
  /** Keyboard: → on a rail section opens its flyout and moves focus in. */
  const openNow = (id: string) => {
    keep()
    wantFocus.current = true
    setHovered(id)
  }
  /** Close and hand focus back to the rail section, not <body>. */
  const closeToRail = React.useCallback(() => {
    const id = hovered
    close()
    if (id)
      document
        .querySelector<HTMLElement>(`[data-rail-section="${id}"]`)
        ?.focus()
  }, [hovered, close])

  React.useEffect(() => {
    if (hovered && wantFocus.current) {
      wantFocus.current = false
      panelRef.current?.querySelector<HTMLElement>("a")?.focus()
    }
  }, [hovered])

  // Navigating anywhere closes it.
  const lastPath = React.useRef(pathname)
  React.useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    close()
  }, [pathname, close])

  React.useEffect(() => {
    if (!hovered) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (panelRef.current?.contains(document.activeElement)) closeToRail()
      else close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hovered, close, closeToRail])

  return { hovered, enter, leave, keep, close, openNow, closeToRail, panelRef }
}

/* ── Last page per section ─────────────────────────────────────────────── */

const LAST_KEY = "mars-nav-last"

/** A rail section returns to the page last used inside it, instead of
 * resetting to the section's first page. */
export function useLastPageInSection(): (s: NavSection) => string {
  const pathname = usePathname()
  const [last, setLast] = React.useState<Record<string, string>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(LAST_KEY) ?? "{}")
    } catch {
      return {}
    }
  })
  React.useEffect(() => {
    const s = sectionFor(pathname)
    const page = s.pages.find((p) => isPageActive(pathname, p.href))
    if (!page) return
    setLast((prev) => {
      if (prev[s.id] === page.href) return prev
      const next = { ...prev, [s.id]: page.href }
      try {
        window.localStorage.setItem(LAST_KEY, JSON.stringify(next))
      } catch {
        // Storage unavailable (private mode): sections open their first page.
      }
      return next
    })
  }, [pathname])
  return (s) => {
    const href = last[s.id]
    return href && s.pages.some((p) => p.href === href) ? href : s.pages[0].href
  }
}

/* ── Display settings ──────────────────────────────────────────────────── */

function SettingsMenu() {
  const { density, setDensity } = useUIState()
  const { theme = "system", setTheme } = useTheme()
  const { openShortcuts } = useShortcutsDialog()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Display settings"
        className={cn(RAIL_BUTTON, "data-[popup-open]:bg-(--nav-hover)")}
      >
        <Settings2 size={18} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="right"
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
