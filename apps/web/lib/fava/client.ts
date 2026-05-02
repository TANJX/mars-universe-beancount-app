// Typed fetch wrapper for the Fava JSON API.
//
// Fava wraps every response in `{ data, mtime }`. The `mtime` is the Beancount
// file mtime; we forward it back to React Query as part of the cache key so
// file edits invalidate cleanly.

import { z } from "zod"

const ENVELOPE = z.object({
  data: z.unknown(),
  mtime: z.union([z.number(), z.string(), z.null()]).optional(),
})

export class FavaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message)
    this.name = "FavaError"
  }
}

export interface FavaEnvelope<T> {
  data: T
  mtime: string
}

export async function favaFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<FavaEnvelope<T>> {
  const url = `/api/fava/${path.replace(/^\//, "")}`
  console.log("favaFetch", url)
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    throw new FavaError(
      `Network error contacting Fava (${url}). Is \`just fava\` running?`,
      undefined,
      url
    )
  }
  if (!res.ok) {
    throw new FavaError(
      `Fava returned HTTP ${res.status} for ${url}`,
      res.status,
      url
    )
  }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new FavaError(
      `Fava response was not valid JSON (${url})`,
      res.status,
      url
    )
  }
  const env = ENVELOPE.safeParse(raw)
  if (!env.success) {
    throw new FavaError(
      `Fava response missing { data, mtime } envelope (${url})`,
      res.status,
      url
    )
  }
  const parsed = schema.safeParse(env.data.data)
  if (!parsed.success) {
    throw new FavaError(
      `Fava response failed schema validation (${url}): ${parsed.error.message}`,
      res.status,
      url
    )
  }
  return { data: parsed.data, mtime: String(env.data.mtime ?? "") }
}

// Build a query string only including non-empty values.
export function favaQuery(
  params: Record<string, string | number | undefined | null>
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  )
  if (entries.length === 0) return ""
  const usp = new URLSearchParams()
  for (const [k, v] of entries) usp.set(k, String(v))
  return `?${usp.toString()}`
}
