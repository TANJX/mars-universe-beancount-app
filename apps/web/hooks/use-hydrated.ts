import * as React from "react"

const noopSubscribe: (onStoreChange: () => void) => () => void = () => () => {}

export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
}
