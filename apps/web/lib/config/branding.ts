import type { Branding } from "./types"
import type { UIConfigWire } from "./schema"

export const BRANDING_DEFAULTS: Branding = {
  title: "Ledger",
  subtitle: "",
}

export function resolveBranding(user: UIConfigWire["branding"]): Branding {
  if (!user) return BRANDING_DEFAULTS
  return {
    title: user.title ?? BRANDING_DEFAULTS.title,
    subtitle: user.subtitle ?? BRANDING_DEFAULTS.subtitle,
  }
}
