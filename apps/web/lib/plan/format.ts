const SAFE_FORMULA = /^[\d+\-*/.\s()]+$/

export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null
  if (typeof raw === "string" && raw.startsWith("=")) {
    const expr = raw.slice(1)
    if (!SAFE_FORMULA.test(expr)) return null
    try {
      const result = Function(`"use strict"; return (${expr})`)() as unknown
      return typeof result === "number" && Number.isFinite(result)
        ? result
        : null
    } catch {
      return null
    }
  }
  const n = parseFloat(String(raw))
  return Number.isFinite(n) ? n : null
}
