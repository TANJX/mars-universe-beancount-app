"use client"

// Building blocks shared by the inputs pane's cards: the folding card, a
// labelled field with its edited dot, and the month input.

import { ChevronDown } from "lucide-react"
import * as React from "react"

import { InfoTip } from "@/components/fire/controls"
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
  children,
}: {
  title: string
  hint: string
  summary: string
  children: React.ReactNode
}) {
  // The page only renders after the client fetch, so the media query is
  // known on first render: no flash from a default-then-correct state.
  const [open, setOpen] = React.useState(
    () =>
      typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches
  )
  return (
    <Card className="gap-0 p-0">
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-muted-foreground text-xs tracking-wide">
              {title}
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
  label = "Edited; reset to config",
}: {
  onReset: () => void
  label?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Edited. Click to reset to config."
      onClick={onReset}
      className="relative size-1.5 shrink-0 rounded-full bg-primary outline-none before:absolute before:-inset-2 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:before:-inset-4"
    />
  )
}

export function Field({
  id,
  label,
  edited,
  onReset,
  info,
  aside,
  error,
  className,
  children,
}: {
  id?: string
  label: string
  edited?: boolean
  onReset?: () => void
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
        {aside ? (
          <span className="ml-auto text-muted-foreground">{aside}</span>
        ) : null}
      </div>
      {children}
      {error ? (
        <span className="text-rose-600 text-xs dark:text-rose-400">
          {error}
        </span>
      ) : null}
    </div>
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
