"use client"

// Small input atoms for the FIRE page: a labelled slider, a compact numeric
// field that commits on blur/Enter, a switch, and a section card shell.

import { Slider } from "@base-ui/react/slider"
import { Switch } from "@base-ui/react/switch"
import { Info, Minus, Plus } from "lucide-react"
import * as React from "react"

import { Card } from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatMoney } from "@/lib/format"
import { cn } from "@/lib/utils"

export function usd(v: number): string {
  return formatMoney(v, { maximumFractionDigits: 0 })
}

/** $1.2M / $340k / $900 — for dense chart axes and chips. */
export function usdShort(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? "−" : ""
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`
  return `${sign}$${Math.round(a)}`
}

export function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`
}

export function SectionCard({
  title,
  hint,
  action,
  className,
  children,
}: {
  title: string
  hint?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn("gap-3 p-0", className)}>
      <div className="flex items-start justify-between gap-4 px-4 pt-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-xs tracking-wide text-muted-foreground">
            {title}
          </span>
          {hint ? (
            <span className="text-muted-foreground text-xs">{hint}</span>
          ) : null}
        </div>
        {action}
      </div>
      {/* Container, not viewport: the same card sits in a narrow pane at xl
          and full width below it, so its inner grid keys off its own width. */}
      <div className="@container px-4 pb-4">{children}</div>
    </Card>
  )
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  hint,
  info,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  hint?: React.ReactNode
  /** Explanation shown in a tooltip from an info icon after the label. */
  info?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1">
          {label}
          {info ? <InfoTip label={label}>{info}</InfoTip> : null}
        </span>
        <span className="font-mono tabular-nums">{format(value)}</span>
      </div>
      <Slider.Root
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v as number)}
      >
        <Slider.Control className="flex h-4 w-full touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-muted">
            <Slider.Indicator className="rounded-full bg-primary" />
            <Slider.Thumb
              aria-label={label}
              className="size-3.5 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      {hint ? (
        <span className="text-muted-foreground text-xs">{hint}</span>
      ) : null}
    </div>
  )
}

/** Numeric field that keeps a local draft and commits on blur or Enter, so
 * typing "1" on the way to "150000" doesn't re-run the projection 6 times. */
export function NumberField({
  value,
  onChange,
  step = 1,
  className,
  prefix,
  suffix,
  ariaLabel,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  className?: string
  prefix?: string
  suffix?: string
  ariaLabel: string
}) {
  const [draft, setDraft] = React.useState(String(value))
  React.useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft.replace(/[,$\s]/g, ""))
    if (Number.isFinite(n)) onChange(n)
    else setDraft(String(value))
  }
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs focus-within:border-ring dark:bg-input/30",
        className
      )}
    >
      {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        }}
        className="w-full min-w-0 bg-transparent font-mono tabular-nums outline-none"
      />
      {suffix ? <span className="text-muted-foreground">{suffix}</span> : null}
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full bg-muted transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[checked]:bg-primary"
    >
      <Switch.Thumb className="block size-3 translate-x-0.5 translate-y-0.5 rounded-full bg-background shadow-sm transition-transform data-[checked]:translate-x-3.5" />
    </Switch.Root>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex h-7 items-center rounded-lg bg-muted p-[3px] text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-full rounded-md px-2.5 font-medium text-muted-foreground transition-colors",
            value === o.value && "bg-background text-foreground shadow-sm"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-lg tracking-tight tabular-nums">
        {value}
      </span>
      {sub ? (
        <span className="text-muted-foreground text-xs">{sub}</span>
      ) : null}
    </div>
  )
}

export function YearStepper({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const btn =
    "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Earlier"
        className={btn}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={12} />
      </button>
      <span className="w-10 text-center font-mono tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="Later"
        className={btn}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={12} />
      </button>
    </span>
  )
}

/** Small focusable info icon that explains a control on hover or focus. */
export function InfoTip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={`About ${label}`}
        className="inline-flex cursor-help rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info className="size-3" />
      </TooltipTrigger>
      <TooltipContent className="block">{children}</TooltipContent>
    </Tooltip>
  )
}
