// Binding schemas for the agent-written dashboard spec.
//
// Guardrail: every number on the dashboard comes from data. A data-backed
// prop accepts only a `{ "$state": "/json/pointer" }` reference into the data
// document, so a baked-in literal fails the props schema itself. These
// schemas describe the RAW spec (what the agent writes); the json-render
// renderer resolves the references before a component sees its props, and
// `Resolve<P>` gives the resolved prop types for registry components.
import { z } from "zod"

/** True for a pointer segment that is a numeric array index ("0", "12"). */
export function isIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment)
}

/**
 * Problems with a JSON pointer used in a binding, or [] when it is fine.
 * Rules: starts with "/", no empty segments, no numeric array indexes
 * (`/derived/cardsDue/0/due` breaks on a day with no cards due).
 */
export function pointerIssues(pointer: string): string[] {
  if (!pointer.startsWith("/")) return ["must start with '/'"]
  const issues: string[] = []
  const segments = pointer.slice(1).split("/")
  if (segments.some((s) => s === "")) issues.push("has an empty segment")
  const idx = segments.filter(isIndexSegment)
  if (idx.length > 0)
    issues.push(
      `has a numeric array index (${idx.join(", ")}); bind the whole array instead`
    )
  return issues
}

/** A JSON pointer that passes `pointerIssues`. */
export const Pointer = z
  .string()
  .min(2)
  .superRefine((p, ctx) => {
    for (const message of pointerIssues(p))
      ctx.addIssue({ code: "custom", message })
  })
  .describe(
    "JSON pointer into the data document, e.g. /netWorth/value. No numeric array indexes."
  )

const BoundSchema = z
  .strictObject({ $state: Pointer })
  .describe(
    'Data binding: { "$state": "/json/pointer" }. Literal values are rejected.'
  )

declare const VALUE: unique symbol
/**
 * A `$state` reference whose pointer resolves to a `T`. The brand is type-only:
 * it lets `Resolve<P>` recover the resolved type for registry components.
 */
export type BoundRef<T> = { $state: string; readonly [VALUE]?: T }

/** Schema for a data-backed prop: `{ "$state": pointer }` only, never a literal. */
export function bound<T>(): z.ZodType<BoundRef<T>> {
  return BoundSchema as unknown as z.ZodType<BoundRef<T>>
}

// ── Literal text ───────────────────────────────────────────────────────

export interface LiteralTextOptions {
  /**
   * Allow a bare four-digit year (1900 to 2099), e.g. a Panel title such as
   * "2026 contributions". Off everywhere else: a year-like figure in a
   * sentence ("2000 under usual") is an amount in disguise.
   */
  allowYears?: boolean
}

/** A bare year: 19xx or 20xx with nothing number-like attached. */
const YEAR = /^(19|20)\d\d$/

/**
 * Problems with literal text the agent wrote, or [] when it is fine. Literal
 * text may not carry amounts:
 * - no currency figures ("$5", "40 USD", "40 dollars");
 * - no scaled or percent figures ("1.2k", "3m", "2bn", "85%", "40 percent");
 * - no numbers of three or more digits, except a bare year when
 *   `allowYears` is set (Panel title and eyebrow only).
 * Small counts like "30d" pass; the prompt still says never to type a count.
 */
export function literalTextIssues(
  text: string,
  opts: LiteralTextOptions = {}
): string[] {
  const issues: string[] = []
  if (
    /[$¥€£]\s?[-−]?\d/.test(text) ||
    /\d\s?(USD|JPY|CNY|EUR|GBP)\b/i.test(text) ||
    /\d\s*(dollars?|bucks|yen)\b/i.test(text)
  )
    issues.push("contains a currency amount; bind it with $format instead")
  const scaled =
    text.match(
      /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:k|m|mm|b|bn|%|percent|pct)(?![A-Za-z])/gi
    ) ?? []
  if (scaled.length > 0)
    issues.push(
      `contains a scaled or percent figure (${scaled.join(", ")}); bind it with $format instead`
    )
  const digitRuns = text.match(/\d[\d,.]*\d|\d/g) ?? []
  const big = digitRuns.filter((run) => {
    const digits = run.replace(/[,.]/g, "")
    if (digits.length < 3) return false
    return !(opts.allowYears && YEAR.test(run))
  })
  if (big.length > 0)
    issues.push(
      `contains a literal number (${big.join(", ")}); numbers must be bound to data${opts.allowYears ? "" : " (a year is allowed only in a Panel title or eyebrow)"}`
    )
  return issues
}

/** A short literal label or sentence, checked by `literalTextIssues`. */
export function literalText(max: number, opts: LiteralTextOptions = {}) {
  return z
    .string()
    .min(1)
    .max(max)
    .superRefine((t, ctx) => {
      for (const message of literalTextIssues(t, opts))
        ctx.addIssue({ code: "custom", message })
    })
}

// ── Rich text (Note) ───────────────────────────────────────────────────

/** `$format` kinds the dashboard supports in text. */
export const FORMAT_KINDS = ["currency", "number", "percent", "date"] as const

/**
 * `{ "$format": kind, "value": { "$state": ... } }`: a bound value formatted
 * for text. `value` must be a binding, never a literal.
 */
export const FormatExpr = z
  .strictObject({
    $format: z.enum(FORMAT_KINDS),
    value: BoundSchema,
    digits: z
      .union([z.literal(0), z.literal(2)])
      .optional()
      .describe("currency only: fraction digits, default 0"),
    signed: z
      .boolean()
      .optional()
      .describe("currency/number: prefix + on positive values"),
    abs: z
      .boolean()
      .optional()
      .describe("currency/number: drop the sign (for 'X under/over' phrasing)"),
  })
  .describe(
    'Formatted bound value: { "$format": "currency", "value": { "$state": "/derived/paceDelta" }, "abs": true }'
  )

/** One piece of a `$concat` text: literal words, a bound string, or a `$format`. */
export const TextPart = z.union([literalText(200), BoundSchema, FormatExpr])

/** `{ "$concat": [parts...] }`: literal words mixed with bound, formatted values. */
export const ConcatExpr = z
  .strictObject({ $concat: z.array(TextPart).min(1).max(24) })
  .describe(
    'Text mixing words and bound values: { "$concat": ["You are ", { "$format": "currency", "value": { "$state": "/derived/paceDelta" }, "abs": true }, " under usual."] }'
  )

declare const TEXT: unique symbol
/** Raw text expression; resolves to a string at render time. */
export type TextExpr = (
  | z.infer<typeof ConcatExpr>
  | z.infer<typeof FormatExpr>
) & {
  readonly [TEXT]?: true
}
/** Text the agent writes: a literal string or a `$concat` / `$format` expression. */
export type RichText = string | TextExpr

/** Schema for a text prop that may embed formatted bound values. */
export function richText(max = 280): z.ZodType<RichText> {
  return z.union([
    literalText(max),
    ConcatExpr,
    FormatExpr,
  ]) as unknown as z.ZodType<RichText>
}

// ── Resolved prop types ────────────────────────────────────────────────

type ResolveValue<V> =
  V extends BoundRef<infer T>
    ? T
    : [Exclude<V, string>] extends [never]
      ? V
      : Exclude<V, string> extends TextExpr
        ? string
        : V

/** Props as a registry component receives them, after bindings resolve. */
export type Resolve<P> = { [K in keyof P]: ResolveValue<P[K]> }
