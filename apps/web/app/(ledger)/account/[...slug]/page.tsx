import { redirect } from "next/navigation"

/**
 * `/account/Assets/Checking/BofA` → `/journal?account=Assets:Checking:BofA`.
 *
 * For now this is a soft redirect to the Journal page filtered by the account
 * (which already has the cumulative column when filter is active). A
 * dedicated drill-down page with a balance-line chart on top is a follow-up.
 */
export default async function AccountPage({
  params,
}: {
  params: Promise<{ slug: string[] }>
}) {
  const { slug } = await params
  const account = slug.map(decodeURIComponent).join(":")
  redirect(`/journal?account=${encodeURIComponent(account)}`)
}
