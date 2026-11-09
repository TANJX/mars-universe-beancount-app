// Axis helpers shared by the FIRE and Runway charts.

const BALANCE_STEPS = [50e3, 100e3, 200e3, 250e3, 500e3, 1e6, 2e6, 5e6]
/** Smaller steps for monthly flows (pay, spending). */
export const FLOW_STEPS = [500, 1000, 2000, 2500, 5000, 10000]

/** Round-number ticks, about 8 to 14 of them: recharts' default 5 lands on
 * values like $850k and $1.70M that are hard to read across. */
export function niceTicks(
  max: number,
  steps: number[] = BALANCE_STEPS,
  maxTicks = 14
): { max: number; ticks: number[] } {
  const step = steps.find((x) => max / x <= maxTicks) ?? (steps.at(-1) ?? 1) * 2
  const top = Math.max(step, Math.ceil(max / step) * step)
  const ticks = Array.from(
    { length: Math.round(top / step) + 1 },
    (_, i) => i * step
  )
  return { max: top, ticks }
}

/** $250k, $1.5M, $2M: no trailing zeros on an axis. */
export function axisMoney(v: number): string {
  if (v >= 1e6) return `$${Number((v / 1e6).toFixed(2))}M`
  if (v >= 1e3) return `$${Number((v / 1e3).toFixed(1))}k`
  return `$${v}`
}
