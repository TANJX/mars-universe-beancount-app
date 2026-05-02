// Group a list into descending date buckets. Used by the mobile timeline
// pages (Expenses, Journal). Sorts the source desc by date first so today
// sits at the top. Total is computed from `getAmount` if provided.

export interface DateGroup<T> {
  date: string
  rows: T[]
  total: number
}

export function groupByDate<T>(
  rows: T[],
  getDate: (row: T) => string,
  getAmount?: (row: T) => number
): DateGroup<T>[] {
  const sorted = [...rows].sort((a, b) => (getDate(a) < getDate(b) ? 1 : -1))
  const out: DateGroup<T>[] = []
  let cur: DateGroup<T> | null = null
  for (const r of sorted) {
    const d = getDate(r)
    if (!cur || cur.date !== d) {
      cur = { date: d, rows: [], total: 0 }
      out.push(cur)
    }
    cur.rows.push(r)
    if (getAmount) cur.total += getAmount(r)
  }
  return out
}
