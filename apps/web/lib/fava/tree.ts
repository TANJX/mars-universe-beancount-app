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
