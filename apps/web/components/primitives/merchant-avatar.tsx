"use client"

import * as React from "react"

import { useResolvedUIConfig } from "@/lib/config"
import { resolveMerchant, type Resolved } from "@/lib/merchants/resolve"
import { deriveFallback, type AvatarFallback } from "@/lib/merchants/avatar-fallback"
import { cn } from "@/lib/utils"
import type { JournalRow } from "@/lib/types/views"

// One canonical size per surface so the avatar is consistent everywhere it
// appears. Use the named `size` prop in call sites; only fall back to a
// numeric size for special cases (e.g. detail sheet).
export const AVATAR_SIZES = {
  sm: 24, // tight rows (compact density)
  md: 28, // default — Recent Activity, Journal, Expenses
  lg: 40, // detail sheet / hero
} as const

export type AvatarSize = keyof typeof AVATAR_SIZES

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

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden border bg-card",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
      }}
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
      <img
        src={resolved.src}
        alt={resolved.alt}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={cn(
          "object-cover transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0"
        )}
        style={{ width: size, height: size }}
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
        ? "bg-primary/15 text-primary"
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
      }}
      aria-label={resolved.alt}
      title={resolved.alt}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.75} />
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
