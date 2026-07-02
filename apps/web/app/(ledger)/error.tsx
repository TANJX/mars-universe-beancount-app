"use client"

import { AlertCircle, RotateCw } from "lucide-react"

export default function LedgerError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex items-center gap-2 text-rose-500">
        <AlertCircle size={20} />
        <span className="text-sm font-medium">Something went wrong</span>
      </div>
      <p className="max-w-md text-xs text-muted-foreground">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent/60"
      >
        <RotateCw size={14} />
        Try again
      </button>
    </div>
  )
}
