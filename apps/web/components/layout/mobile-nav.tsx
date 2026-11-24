"use client"

// Mobile navigation: no tab bar. A compact "Section / Page ▾" breadcrumb
// opens a Go-to sheet with every page (grouped like the desktop rail), the
// current section's context inline, and display settings. Pages keep their
// own big titles and period controls below it.
// Design record: docs/notes/2026-11-24-navigation-redesign.md

import { ChevronDown, Search } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import * as React from "react"

import { useCommandPalette } from "@/components/layout/command-palette"
import {
  isPageActive,
  NAV_SECTIONS,
  type NavPage,
  pageFor,
  sectionFor,
} from "@/components/layout/nav"
import { SectionExtras } from "@/components/layout/sidebar-extras"
import { usePeriodHref, useUIState } from "@/components/layout/ui-state"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { Density } from "@/lib/types/views"
import { cn } from "@/lib/utils"

export function MobileNavHeader() {
  const pathname = usePathname()
  const { openCommandPalette } = useCommandPalette()
  const [open, setOpen] = React.useState(false)
  const close = () => setOpen(false)
  const page = pageFor(pathname)
  const section = sectionFor(pathname)
  const showSection = section.pages.length > 1

  return (
    <header
      className="flex shrink-0 items-center gap-1 border-b-(length:--hairline) border-b-border bg-background px-2"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${section.label}, ${page?.label ?? "Ledger"}. Go to another page`}
        className="flex min-h-11 min-w-0 touch-manipulation items-center gap-1.5 rounded-lg px-2 text-[15px] transition-[background-color,scale] duration-150 ease-out select-none active:scale-[0.97] active:bg-muted"
      >
        {showSection && (
          <>
            <span className="shrink-0 text-muted-foreground">
              {section.label}
            </span>
            <span aria-hidden className="text-muted-foreground/50">
              /
            </span>
          </>
        )}
        <span className="truncate font-medium">{page?.label ?? "Ledger"}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
      </button>
      <div className="flex-1" />
      <button
        type="button"
        aria-label="Search"
        onClick={openCommandPalette}
        className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-[background-color,scale] duration-150 ease-out select-none active:scale-[0.97] active:bg-muted"
      >
        <Search size={20} />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-2xl"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30"
          />
          <SheetHeader className="px-5 pt-3 pb-2">
            <SheetTitle>Go to</SheetTitle>
            <SheetDescription className="sr-only">
              Pages, bookmarks and display settings
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-4">
            {NAV_SECTIONS.map((s) => (
              <SheetGroup key={s.id} label={s.label}>
                {s.pages.map((p) => (
                  <PageRow key={p.href} page={p} onNavigate={close} />
                ))}
                {s.id === section.id && (
                  <div className="pb-1 pl-10">
                    <SectionExtras sectionId={s.id} touch onNavigate={close} />
                  </div>
                )}
              </SheetGroup>
            ))}
            <DisplaySettings />
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}

function SheetGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section className="pt-3">
      <h3 className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

function PageRow({
  page,
  onNavigate,
}: {
  page: NavPage
  onNavigate: () => void
}) {
  const pathname = usePathname()
  const periodHref = usePeriodHref()
  const active = isPageActive(pathname, page.href)
  const Icon = page.icon
  return (
    <Link
      href={periodHref(page.href)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-12 touch-manipulation items-center gap-3 rounded-xl px-2 transition-[background-color] duration-150 ease-out select-none active:bg-muted",
        active && "bg-muted"
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-tight font-medium">
          {page.label}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {page.hint}
        </span>
      </span>
    </Link>
  )
}

function DisplaySettings() {
  const { density, setDensity } = useUIState()
  const { theme = "system", setTheme } = useTheme()
  return (
    <SheetGroup label="Display">
      <Choice
        label="Theme"
        value={theme}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "Auto" },
        ]}
        onChange={setTheme}
      />
      <Choice
        label="Rows"
        value={density}
        options={[
          { value: "comfortable", label: "Roomy" },
          { value: "compact", label: "Compact" },
        ]}
        onChange={(v) => setDensity(v as Density)}
      />
    </SheetGroup>
  )
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5">
      <span className="text-[15px]">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex rounded-lg bg-muted p-0.5"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-9 touch-manipulation rounded-md px-3 text-[13px] font-medium transition-[background-color,color] duration-150 ease-out select-none",
              value === o.value
                ? "bg-background text-foreground shadow-(--elev-pill)"
                : "text-muted-foreground"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
