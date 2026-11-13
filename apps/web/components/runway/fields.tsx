"use client"

// Building blocks shared by the inputs pane's cards: the folding card, a
// labelled field with its markers, and the month input.
//
// Two markers, answering different questions:
//   EditedDot       the value differs from what is saved (Save writes it);
//                   clicking resets it to the saved value.
//   FallbackReset   "Plan: $5,792" or "Shared: 7.0%": the active scenario (or
//                   this person) overrides the next level down; clicking
//                   removes the override.

import { ChevronDown, RotateCcw } from "lucide-react"
import * as React from "react"

import { InfoTip } from "@/components/fire/controls"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const MOBILE_QUERY = "(max-width: 767px)"

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Card whose body folds on phones; the summary keeps its key values. */
export function InputsSection({
  title,
  hint,
  summary,
  badge,
  icon,
  id,
  forceOpen,
  children,
}: {
  title: string
  hint: string
  summary: string
  /** Shown beside the title, open or closed ("2 from Plan", "Error"). */
  badge?: React.ReactNode
  icon?: React.ReactNode
  id?: string
  /** Opens the card when it becomes true (errors inside, say). */
  forceOpen?: boolean
  children: React.ReactNode
}) {
  // The page only renders after the client fetch, so the media query is
  // known on first render: no flash from a default-then-correct state.
  const [open, setOpen] = React.useState(
    () =>
      typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches
  )
  React.useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])
  return (
    <Card id={id} className="scroll-mt-14 gap-0 p-0">
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs tracking-wide">
              {icon}
              {title}
              {badge}
            </span>
            <span className="text-muted-foreground text-xs group-open:hidden">
              <span className="font-mono tabular-nums">{summary}</span>
            </span>
            <span className="hidden text-muted-foreground text-xs group-open:block">
              {hint}
            </span>
          </span>
          <ChevronDown
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="@container px-4 pb-4">
          <div className="grid gap-x-4 gap-y-3 @md:grid-cols-2">{children}</div>
        </div>
      </details>
    </Card>
  )
}

/** Marks a value that differs from config; clicking it resets that value.
 * The dot is 6px, so its hit area is padded out (further on touch). */
export function EditedDot({
  onReset,
  label = "Unsaved change. Reset to saved value.",
}: {
  onReset: () => void
  label?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Unsaved change. Click to reset to the saved value."
      onClick={onReset}
      className="relative size-1.5 shrink-0 rounded-full bg-primary outline-none before:absolute before:-inset-2 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:before:-inset-4"
    />
  )
}

/** What a field falls back to when its override is removed. */
export interface Fallback {
  source: "Plan" | "Shared"
  /** The fallback value, formatted. */
  text: string
  onReset: () => void
}

/** "Plan: $5,792 ↺": the field overrides the next level down; click to
 * follow it again. Always visible (no hover reveal). */
export function FallbackReset({ source, text, onReset }: Fallback) {
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label={`Reset to ${source} value, ${text}`}
      title={`Differs from ${source}. Click to use ${text}.`}
      className="relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground text-xs outline-none before:absolute before:-inset-y-2 hover:text-foreground focus-visible:text-foreground focus-visible:underline pointer-coarse:before:-inset-y-3"
    >
      {source}: <span className="font-mono tabular-nums">{text}</span>
      <RotateCcw size={11} aria-hidden="true" />
    </button>
  )
}

/** A small tag on a list row: "Added in scenario", "Off". */
export function RowTag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode
  tone?: "muted" | "error"
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 shrink-0 px-1.5 font-normal text-[11px]",
        tone === "error"
          ? "border-rose-300 text-rose-600 dark:border-rose-800 dark:text-rose-400"
          : "text-muted-foreground"
      )}
    >
      {children}
    </Badge>
  )
}

export function Field({
  id,
  label,
  edited,
  onReset,
  fallback,
  info,
  aside,
  error,
  className,
  children,
}: {
  id?: string
  label: string
  /** Differs from the saved value. */
  edited?: boolean
  onReset?: () => void
  /** Overrides the plan (in a scenario) or the shared default. */
  fallback?: Fallback | null
  info?: React.ReactNode
  aside?: React.ReactNode
  error?: string | null
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5 text-xs">
        <label htmlFor={id}>{label}</label>
        {info ? <InfoTip label={label}>{info}</InfoTip> : null}
        {edited && onReset ? <EditedDot onReset={onReset} /> : null}
        {fallback ? (
          <span className="ml-auto">
            <FallbackReset {...fallback} />
          </span>
        ) : aside ? (
          <span className="ml-auto text-muted-foreground">{aside}</span>
        ) : null}
      </div>
      {children}
      {fallback && aside ? (
        <span className="text-muted-foreground text-xs">{aside}</span>
      ) : null}
      {error ? (
        <span
          className="text-rose-600 text-xs dark:text-rose-400"
          data-field-error=""
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

/** The dot and fallback pair for slider rows, which have no Field wrapper. */
export function Markers({
  edited,
  onReset,
  fallback,
}: {
  edited?: boolean
  onReset?: () => void
  fallback?: Fallback | null
}) {
  if (!edited && !fallback) return null
  return (
    <span className="inline-flex items-center gap-2">
      {edited && onReset ? <EditedDot onReset={onReset} /> : null}
      {fallback ? <FallbackReset {...fallback} /> : null}
    </span>
  )
}

/** Field height and text size: 16px on phones so iOS does not zoom. */
export const FIELD =
  "h-9 w-full text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"

export function MonthField({
  id,
  value,
  onChange,
  min,
  max,
  ariaLabel,
  className,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  min?: string
  max?: string
  ariaLabel: string
  className?: string
}) {
  return (
    <input
      id={id}
      type="month"
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(e.target.value)
      }}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-2 font-mono text-base tabular-nums outline-none focus-visible:border-ring md:h-7 md:text-xs dark:bg-input/30",
        className
      )}
    />
  )
}

export function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-medium text-muted-foreground text-xs @md:col-span-2">
      {children}
    </div>
  )
}
