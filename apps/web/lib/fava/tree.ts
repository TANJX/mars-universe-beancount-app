// Convert Fava's SerialisedTreeNode → our BalanceTreeNode.
// Renames snake_case wire fields and precomputes the `segment` (last colon
// segment) so renderers don't have to derive it.

import type { SerialisedTreeNode } from "@/lib/fava/schemas"
import { accountSegment } from "@/lib/transform/classify"
import type { BalanceTreeNode } from "@/lib/types/views"

export function convertTreeNode(n: SerialisedTreeNode): BalanceTreeNode {
  return {
    account: n.account,
    segment: n.account ? accountSegment(n.account) : "",
    balance: n.balance,
    balanceChildren: n.balance_children,
    cost: n.cost ?? undefined,
    costChildren: n.cost_children ?? undefined,
    hasTxns: n.has_txns,
    children: (n.children ?? []).map(convertTreeNode),
  }
}

/**
 * Locate the node for a full account path inside a root tree. Descends only
 * into the branch that prefixes `path`, so it's O(depth) rather than a full
 * walk. Returns null when the account has no node (never posted to).
 */
export function findTreeNode(
  tree: BalanceTreeNode,
  path: string
): BalanceTreeNode | null {
  if (tree.account === path) return tree
  for (const child of tree.children ?? []) {
    if (path === child.account || path.startsWith(`${child.account}:`)) {
      const found = findTreeNode(child, path)
      if (found) return found
    }
  }
  return null
}
