import * as React from "react"

import type { Transaction } from "@/lib/types/beancount"

export interface SearchVocabulary {
  accounts: string[]
  tags: string[]
  links: string[]
  payees: string[]
}

const EMPTY: SearchVocabulary = {
  accounts: [],
  tags: [],
  links: [],
  payees: [],
}

/**
 * Derives the suggestion pool for the search bar from the in-memory journal.
 * Each field is sorted + deduped. Pulls from whatever txns are currently
 * loaded, so suggestions reflect the active period and primary-account scope.
 */
export function useSearchVocabulary(
  txns: Transaction[] | undefined
): SearchVocabulary {
  return React.useMemo(() => {
    if (!txns || txns.length === 0) return EMPTY
    const accounts = new Set<string>()
    const tags = new Set<string>()
    const links = new Set<string>()
    const payees = new Set<string>()
    for (const t of txns) {
      if (t.payee) payees.add(t.payee)
      for (const tag of t.tags) tags.add(tag)
      for (const link of t.links) links.add(link)
      for (const p of t.postings) accounts.add(p.account)
    }
    return {
      accounts: [...accounts].sort(),
      tags: [...tags].sort(),
      links: [...links].sort(),
      payees: [...payees].sort(),
    }
  }, [txns])
}
