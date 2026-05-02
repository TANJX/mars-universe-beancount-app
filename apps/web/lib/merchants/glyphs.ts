import {
  ArrowRightLeft,
  CalendarClock,
  Hourglass,
  LineChart,
  Repeat,
  type LucideIcon,
} from "lucide-react"

export type GlyphTone = "neutral" | "muted" | "accent"

export interface GlyphSpec {
  icon: LucideIcon
  tone: GlyphTone
  label: string
}

/** Glyphs for non-merchant transaction kinds. Class-driven; the resolver
 * picks one before consulting the merchant registry. */
export const GLYPHS = {
  transfer: {
    icon: ArrowRightLeft,
    tone: "muted",
    label: "Transfer",
  } satisfies GlyphSpec,
  rebalance: {
    icon: Repeat,
    tone: "accent",
    label: "Rebalance",
  } satisfies GlyphSpec,
  investment: {
    icon: LineChart,
    tone: "accent",
    label: "Investment",
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
} as const

export type GlyphKind = keyof typeof GLYPHS
