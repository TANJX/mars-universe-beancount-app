"use client"

import * as React from "react"

/**
 * Render `children` only after the client has mounted. Used for components
 * that are not SSR-stable — notably Base UI's Floating tree (popover,
 * dropdown, dialog), which generates non-deterministic IDs and triggers
 * hydration warnings even before the popover opens.
 *
 * The `fallback` is rendered during SSR + the first paint to keep layout
 * stable.
 */
interface ClientOnlyProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  if (!mounted) return <>{fallback}</>
  return <>{children}</>
}
