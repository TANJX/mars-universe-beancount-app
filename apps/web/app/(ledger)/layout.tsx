import { LedgerShell } from "@/components/layout/ledger-shell"
import { ShortcutsDialog } from "@/components/layout/shortcuts-dialog"
import { UIStateProvider } from "@/components/layout/ui-state"

// Ledger pages read URL period state via nuqs's `useQueryStates`, which
// requires a Suspense boundary or dynamic rendering during prerender.
// The ledger is a logged-in finance dashboard — never useful as a static
// page — so opt out of static rendering at the layout level.
export const dynamic = "force-dynamic"

export default function LedgerLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <UIStateProvider>
      <ShortcutsDialog>
        <LedgerShell>{children}</LedgerShell>
      </ShortcutsDialog>
    </UIStateProvider>
  )
}
