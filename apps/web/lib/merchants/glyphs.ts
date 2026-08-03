import {
  ArrowRightLeft,
  BadgePercent,
  CalendarClock,
  Hourglass,
  LineChart,
  type LucideIcon,
  Scale,
} from "lucide-react"

export type GlyphTone = "neutral" | "muted" | "accent"

export interface GlyphSpec {
  icon: LucideIcon
  tone: GlyphTone
  label: string
}

/** Glyphs for non-merchant transaction kinds. Class-driven; the resolver
 * picks one before consulting the merchant registry. Static imports for
 * tree-shaking — the category-icon fallback (stage 4.5) is rendered via
 * `lucide-react/dynamic` so any icon name from yaml/defaults works without
 * an allowlist. */
export const GLYPHS = {
  transfer: {
    icon: ArrowRightLeft,
    tone: "muted",
    label: "Transfer",
  } satisfies GlyphSpec,
  investment: {
    icon: LineChart,
    tone: "accent",
    label: "Investment",
  } satisfies GlyphSpec,
  rebate: {
    icon: BadgePercent,
    tone: "accent",
    label: "Rebate",
  } satisfies GlyphSpec,
  pending: {
    icon: Hourglass,
    tone: "muted",
    label: "Pending",
  } satisfies GlyphSpec,
  forecast: {
    icon: CalendarClock,
    tone: "muted",
    label: "Forecast",
  } satisfies GlyphSpec,
  padding: {
    icon: Scale,
    tone: "muted",
    label: "Padding",
  } satisfies GlyphSpec,
} as const

export type GlyphKind = keyof typeof GLYPHS
