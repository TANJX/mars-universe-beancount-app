// logo.dev URL builder. The publishable token lives in
// NEXT_PUBLIC_LOGO_DEV_TOKEN — safe to ship to the client.

const TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN

/** Build a deterministic logo.dev image URL for a domain. Renders 2x for
 * crisp retina display. Returns null when the token isn't configured (used
 * by the resolver to skip the logo branch instead of issuing broken URLs). */
export function logoDevUrl(domain: string, size: number = 64): string | null {
  if (!TOKEN) return null
  const px = Math.max(16, Math.round(size * 2))
  return `https://img.logo.dev/${domain}?token=${TOKEN}&size=${px}&format=webp&retina=true`
}

export function isLogoDevConfigured(): boolean {
  return Boolean(TOKEN)
}
