import { redirect } from "next/navigation"

function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    p?: string | string[]
    from?: string | string[]
    to?: string | string[]
  }>
}) {
  const current = await searchParams
  const params = new URLSearchParams()
  const p = readParam(current.p)
  const from = readParam(current.from)
  const to = readParam(current.to)

  if (p) params.set("p", p)
  if (from) params.set("from", from)
  if (to) params.set("to", to)

  const search = params.toString()
  redirect(search ? `/overview?${search}` : "/overview")
}
