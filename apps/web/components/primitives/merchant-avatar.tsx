"use client"

import { DynamicIcon, type IconName } from "lucide-react/dynamic"
import Image from "next/image"
import * as React from "react"

import { useResolvedUIConfig } from "@/lib/config"
import {
  type AvatarFallback,
  deriveFallback,
} from "@/lib/merchants/avatar-fallback"
import { type Resolved, resolveMerchant } from "@/lib/merchants/resolve"
import type { JournalRow } from "@/lib/types/views"
import { cn } from "@/lib/utils"

// One canonical size per surface so the avatar is consistent everywhere it
// appears. Use the named `size` prop in call sites; only fall back to a
// numeric size for special cases (e.g. detail sheet).
export const AVATAR_SIZES = {
  sm: 24, // tight rows (compact density)
  md: 28, // default — Recent Activity, Journal, Expenses
  lg: 40, // detail sheet / hero
} as const

export type AvatarSize = keyof typeof AVATAR_SIZES

/** Shared plate behind every brand logo, in both themes. Slightly off-white
 * so a pure-white mark still reads as a mark and not as the plate. */
const LOGO_PLATE = "#f4f4f5"

/**
 * Disc + icon colors for a tinted avatar, derived from one hue.
 *
 * The icon can't just BE the hue: a dark hue on a dark surface disappears.
 * `--primary` is a dark red, and `text-primary` on a `primary/15` disc
 * measured 1.94:1 against the row — under the 3:1 floor for non-text. The
 * same happens to any `accounts.colors` entry picked for a chart, where the
 * backdrop is light.
 *
 * Mixing toward `--foreground` fixes both directions at once: it lifts a
 * dark hue in dark mode and deepens a light one in light mode, because
 * `--foreground` flips with the theme. One expression, no per-theme table.
 */
function tintStyle(color: string): React.CSSProperties {
  return {
    background: `color-mix(in oklab, ${color} 16%, transparent)`,
    color: `color-mix(in oklab, ${color} 70%, var(--foreground))`,
  }
}

export interface MerchantAvatarProps {
  /** Preferred — provides class + account context for the resolver. */
  row?: JournalRow
  /** Legacy — used when no row is available (e.g. forecast headers). */
  payee?: string
  /** Named size token. Defaults to "md". A numeric value overrides. */
  size?: AvatarSize | number
  className?: string
}

export function MerchantAvatar({
  row,
  payee,
  size = "md",
  className,
}: MerchantAvatarProps) {
  const px = typeof size === "number" ? size : AVATAR_SIZES[size]
  const ui = useResolvedUIConfig()
  const resolved = React.useMemo(
    () =>
      resolveMerchant({
        row,
        payee,
        size: px,
        registry: ui.merchants,
        accounts: ui.accounts,
      }),
    [row, payee, px, ui.merchants, ui.accounts]
  )

  if (resolved.kind === "logo") {
    return <LogoAvatar resolved={resolved} size={px} className={className} />
  }
  if (resolved.kind === "glyph") {
    return <GlyphAvatar resolved={resolved} size={px} className={className} />
  }
  if (resolved.kind === "category-icon") {
    return (
      <CategoryIconAvatar resolved={resolved} size={px} className={className} />
    )
  }
  return <InitialAvatar resolved={resolved} size={px} className={className} />
}

// ── Logo: <img> with onError that swaps to the entry's letter mark ────────
function LogoAvatar({
  resolved,
  size,
  className,
}: {
  resolved: Extract<Resolved, { kind: "logo" }>
  size: number
  className?: string
}) {
  const [errored, setErrored] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)

  if (errored) {
    return (
      <InitialAvatar
        resolved={{
          kind: "initial",
          entry: resolved.fallback,
          alt: resolved.alt,
        }}
        size={size}
        className={className}
      />
    )
  }

  // The plate is deliberately NOT theme-aware. Brand marks are drawn for
  // light backgrounds: measured across the 47 brands in this ledger, a white
  // plate leaves 5 marks under 3:1 while the dark card leaves 4 — but the
  // dark card only works while the app is dark, and in light mode 26 of them
  // wash out. A mid grey is the worst of both (12 failures), so don't split
  // the difference. The ring carries the 5 near-white marks, whose problem is
  // edge definition rather than glyph contrast.
  const inset = Math.max(2, Math.round(size * 0.14))

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/10 dark:ring-white/15",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: LOGO_PLATE,
      }}
      role="img"
      aria-label={resolved.alt}
    >
      {/* Skeleton swatch / fallback initial visible until the logo loads */}
      {!loaded && (
        <span
          className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums"
          style={{
            background: resolved.fallback.bg,
            color: resolved.fallback.fg,
            fontSize:
              resolved.fallback.initial.length > 1 ? size * 0.38 : size * 0.5,
            letterSpacing: "-0.02em",
          }}
        >
          {resolved.fallback.initial}
        </span>
      )}
      <Image
        src={resolved.src}
        alt={resolved.alt}
        fill
        sizes={`${size}px`}
        unoptimized
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        // `contain`, not `cover`: wide wordmarks (Cathay Pacific, Bilt) were
        // being centre-cropped into an unreadable strip.
        className={cn(
          "object-contain transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0"
        )}
        style={{ padding: inset }}
      />
    </span>
  )
}

// ── Glyph: lucide icon centered in a tonal circle ─────────────────────────
function GlyphAvatar({
  resolved,
  size,
  className,
}: {
  resolved: Extract<Resolved, { kind: "glyph" }>
  size: number
  className?: string
}) {
  const Icon = resolved.glyph.icon
  const tone = resolved.glyph.tone
  const toneClass =
    tone === "muted"
      ? "bg-muted text-muted-foreground"
      : tone === "accent"
        ? ""
        : "bg-card border text-foreground"

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        toneClass,
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(tone === "accent" ? tintStyle("var(--primary)") : {}),
      }}
      role="img"
      aria-label={resolved.alt}
      title={resolved.alt}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.75} />
    </span>
  )
}

// ── Category icon: dynamically-loaded lucide icon (stage 4.5) ─────────────
function CategoryIconAvatar({
  resolved,
  size,
  className,
}: {
  resolved: Extract<Resolved, { kind: "category-icon" }>
  size: number
  className?: string
}) {
  // This is the single most common non-brand avatar in the ledger, and
  // `bg-muted` on `bg-card` gave it almost no separation from the row — a
  // wall of identical grey discs. `accounts.colors` already carries a
  // hand-picked hue per category for the charts; reuse it so Restaurants and
  // Groceries are distinguishable at a glance. Falls back to the old muted
  // treatment for categories with no color configured.
  const { color } = resolved
  const tinted = Boolean(color)

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        !tinted && "bg-muted text-muted-foreground",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(tinted ? tintStyle(color as string) : {}),
      }}
      role="img"
      aria-label={resolved.alt}
      title={resolved.alt}
    >
      <DynamicIcon
        name={resolved.name as IconName}
        size={Math.round(size * 0.5)}
        strokeWidth={1.75}
      />
    </span>
  )
}

// ── Initial: classic colored letter circle ────────────────────────────────
function InitialAvatar({
  resolved,
  size,
  className,
}: {
  resolved: Extract<Resolved, { kind: "initial" }>
  size: number
  className?: string
}) {
  const { entry, alt } = resolved
  const isLong = entry.initial.length > 1
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold tabular-nums",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: entry.bg,
        color: entry.fg,
        fontSize: isLong ? size * 0.38 : size * 0.5,
        letterSpacing: "-0.02em",
      }}
      role="img"
      aria-label={alt}
    >
      {entry.initial}
    </span>
  )
}

// Compatibility shim — old call sites called `fallbackEntryFor(payee)`.
// Re-export the new derived-fallback helper under a similar name so we can
// migrate consumers piecemeal.
export function fallbackEntryFor(
  payee: string | null | undefined
): AvatarFallback {
  return deriveFallback(payee)
}
