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

// ── Root schema ──────────────────────────────────────────────────────────

export const UIConfigSchema = z
  .object({
    branding: BrandingSchema,
    accounts: AccountsSchema,
    merchants: MerchantsSchema,
    sidebar: SidebarSchema,
  })
  .partial()

export type UIConfigWire = z.infer<typeof UIConfigSchema>
