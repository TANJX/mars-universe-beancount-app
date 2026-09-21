// React Query hook for the Portfolio page's single data source.
//
// `/api/ext/portfolio` is a LedgerDataApi extension endpoint (Next rewrites
// `/api/ext/:path*` onto it), so the response is raw JSON rather than Fava's
// `{ data, mtime }` envelope — no `favaFetch` here.
//
// Holdings are as-of a date, NOT scoped by the global period: the period chip
// drives only the time series and the realized totals, both of which the
// endpoint returns in full for the client to window. So the query key is the
// as-of date, not `UIState.period`.

"use client"

import { useQuery } from "@tanstack/react-query"

import { type Portfolio, PortfolioSchema } from "@/lib/fava/schemas"

const ENDPOINT = "/api/ext/portfolio"

export class PortfolioApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message)
    this.name = "PortfolioApiError"
  }
}

/**
 * Today as ISO `YYYY-MM-DD` in the *local* zone. `toISOString()` would be UTC,
 * which rolls the date over mid-evening in US zones and would silently ask the
 * endpoint for tomorrow — where the ledger's future-dated forecast entries
 * live.
 */
function todayISO(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function fetchPortfolio(asof: string): Promise<Portfolio> {
  const url = `${ENDPOINT}?asof=${encodeURIComponent(asof)}`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new PortfolioApiError(
      `Network error contacting fava (${url}). Is \`just fava\` running?`,
      undefined,
      url
    )
  }
  if (!res.ok) {
    throw new PortfolioApiError(
      `Portfolio endpoint returned HTTP ${res.status} for ${url}`,
      res.status,
      url
    )
  }
  // LedgerDataApi endpoints serialise with `json.dumps(...)`; some Flask
  // configurations send that as text/html, which `res.json()` still accepts —
  // but parse the text ourselves to keep the failure message useful.
  const text = await res.text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PortfolioApiError(
      `Response was not JSON (${url})`,
      res.status,
      url
    )
  }
  const parsed = PortfolioSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PortfolioApiError(
      `Response failed schema validation (${url}): ${parsed.error.message}`,
      res.status,
      url
    )
  }
  return parsed.data
}

export interface UsePortfolioOptions {
  /** As-of date, ISO `YYYY-MM-DD`. Defaults to today (local). */
  asof?: string
  /** Skip the request when false. */
  enabled?: boolean
}

export function usePortfolio(opts: UsePortfolioOptions = {}) {
  const asof = opts.asof ?? todayISO()
  return useQuery<Portfolio>({
    queryKey: ["portfolio", asof],
    queryFn: () => fetchPortfolio(asof),
    enabled: opts.enabled ?? true,
    // Prices move once a day at most (`just prices` writes the directives), and
    // the page is a snapshot rather than a live quote board.
    staleTime: 60_000,
  })
}
