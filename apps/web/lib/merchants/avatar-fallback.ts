// Auto-derived letter-mark fallback. Used wherever a merchant has no
// logo.dev domain (or the image fails to load) and for the generic
// unknown-payee bucket.
//
// Initials rule:
//   - 0 words            → "?"
//   - 1 word             → first char, uppercased
//   - 2+ words           → first chars of the first two words, uppercased
//                          ("NJ Transit" → "NJ", "Bank of America" → "BA")
//
// Color rule:
//   - Stable hash of the seed → hue 0–360
//   - Fixed lightness/chroma so all letter marks feel like one family
//   - White text reads on the resulting palette

export interface AvatarFallback {
  initial: string
  bg: string
  fg: string
}

const UNKNOWN: AvatarFallback = {
  initial: "?",
  bg: "#2a2a30",
  fg: "#b8b5ac",
}

export function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].charAt(0).toUpperCase()
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase()
}

function hashHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0
  }
  return ((h % 360) + 360) % 360
}

/** Stable mid-tone color from a seed string. White text is readable on top. */
export function hashColor(seed: string): string {
  return `oklch(0.55 0.16 ${hashHue(seed)})`
}

/** Build the letter-mark for a given name. Empty/missing → muted unknown. */
export function deriveFallback(
  name: string | null | undefined
): AvatarFallback {
  if (!name) return UNKNOWN
  const trimmed = name.trim()
  if (!trimmed) return UNKNOWN
  return {
    initial: deriveInitials(trimmed),
    bg: hashColor(trimmed),
    fg: "#fff",
  }
}
