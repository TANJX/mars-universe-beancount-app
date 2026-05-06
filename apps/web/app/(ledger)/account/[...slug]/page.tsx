import { redirect } from "next/navigation"

function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * `/account/Assets/Checking/BofA` → `/journal?account=Assets:Checking:BofA`.
 *
 * For now this is a soft redirect to the Journal page filtered by the account
 * (which already has the cumulative column when filter is active). A
 * dedicated drill-down page with a balance-line chart on top is a follow-up.
 */
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>
  searchParams: Promise<{
    p?: string | string[]
    from?: string | string[]
    to?: string | string[]
  }>
}) {
  const { slug } = await params
  const current = await searchParams
  const account = slug.map(decodeURIComponent).join(":")
  const next = new URLSearchParams({
    account: account,
  })
  const p = readParam(current.p)
  const from = readParam(current.from)
  const to = readParam(current.to)

  if (p) next.set("p", p)
  if (from) next.set("from", from)
  if (to) next.set("to", to)

  redirect(`/journal?${next.toString()}`)
}
