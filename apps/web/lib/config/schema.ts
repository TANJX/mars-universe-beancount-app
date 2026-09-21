// Composed Zod schema for the /ui-config wire shape. Every section is
// optional; the backend may emit `null` for empty mappings (yaml's `key:`
// with no body), so each section coerces null→default. Per-section
// schemas can be tested independently.

import { z } from "zod"

// ── Section schemas ──────────────────────────────────────────────────────

const BrandingSchema = z
  .object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
  })
  .nullable()
  .optional()

const StringRecordSchema = z
  .record(z.string(), z.string())
  .nullable()
  .optional()
  .transform((v) => v ?? {})

const StringArraySchema = z
  .array(z.string())
  .nullable()
  .optional()
  .transform((v) => v ?? [])

const AccountsSchema = z
  .object({
    display_names: StringRecordSchema,
    logos: StringRecordSchema,
    colors: StringRecordSchema,
    category_icons: StringRecordSchema,
    category_rollup: StringArraySchema,
  })
  .partial()
  .nullable()
  .optional()
  .transform((v) => v ?? {})

const MerchantEntrySchema = z
  .object({
    domain: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .nullable()
  .optional()
  .transform((v) => v ?? {})

const MerchantsSchema = z
  .record(z.string(), MerchantEntrySchema)
  .nullable()
  .optional()
  .transform((v) => v ?? {})

const BookmarkSchema = z.object({
  id: z.string(),
  label: z.string(),
  root: z.enum(["Assets", "Liabilities", "Equity", "Income", "Expenses"]),
  accountPath: z.string(),
})

const SidebarSchema = z
  .object({
    bookmarks: z.array(BookmarkSchema).nullable().optional(),
  })
  .partial()
  .nullable()
  .optional()
  .transform((v) => v ?? {})

// ── Investments ──────────────────────────────────────────────────────────
// Sleeves are DISCOVERED server-side by walking Assets:Investment:*; this
// block only annotates them. Enum-ish fields (`tax`, `per`) stay `z.string()`
// here and are narrowed in the resolver: a typo must not fail the parse,
// because the fetcher falls back to `{}` on error and that would blank every
// other section too. `.catch()` on the section is the same argument one level
// up — a malformed `investments:` degrades to "no annotations", nothing more.

const InvestmentSleeveSchema = z.object({
  account: z.string(),
  tax: z.string().nullable().optional(),
  limit_key: z.string().nullable().optional(),
  margin_free_tranche: z.number().nullable().optional(),
})

const CadenceSchema = z
  .object({
    amount: z.number(),
    per: z.string(),
  })
  .nullable()

const InvestmentsSchema = z
  .object({
    sleeves: z.array(InvestmentSleeveSchema).nullable().optional(),
    // `limits: { 2026: { ira: 7500 } }` — YAML int keys arrive as JSON
    // strings, so the outer record is keyed by string.
    limits: z
      .record(z.string(), z.record(z.string(), z.number()).nullable())
      .nullable()
      .optional(),
    cadence: z.record(z.string(), CadenceSchema).nullable().optional(),
    realized: z
      .object({
        gains: z.string().nullable().optional(),
        dividends: z.string().nullable().optional(),
      })
      .partial()
      .nullable()
      .optional(),
    asset_class_labels: StringRecordSchema,
  })
  .partial()
  .nullable()
  .optional()
  .catch(undefined)
  .transform((v) => v ?? {})

// ── Root schema ──────────────────────────────────────────────────────────

export const UIConfigSchema = z
  .object({
    branding: BrandingSchema,
    accounts: AccountsSchema,
    merchants: MerchantsSchema,
    sidebar: SidebarSchema,
    investments: InvestmentsSchema,
  })
  .partial()

export type UIConfigWire = z.infer<typeof UIConfigSchema>
