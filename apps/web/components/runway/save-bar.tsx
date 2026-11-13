"use client"

// The save bar: what Save would write, and the result of the last save.
// Sticky at the bottom of the pane on wide screens, fixed to the bottom of
// the viewport below xl (clear of the home indicator). Shown only while
// something is unsaved or a result is on screen.

import { AlertTriangle, Check, Loader2 } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import type { RunwayIssue } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; files: string[] }
  | { kind: "saved"; files: string[] }
  | { kind: "invalid"; issues: RunwayIssue[]; unmapped: RunwayIssue[] }
  | { kind: "unreachable" }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "discarded"; n: number }

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

export function SaveBar({
  state,
  changes,
  targets,
  restored,
  stale,
  others,
  onSave,
  onDiscard,
  onUndo,
  onShow,
  onSwitch,
  onHeight,
}: {
  state: SaveState
  /** Unsaved changes for the current person plus Shared. */
  changes: number
  /** What Save writes: "Mars: Plan, Next job · Shared (changes both people)". */
  targets: string
  restored: boolean
  stale: string | null
  /** Another person with unsaved edits (not saved by this Save). */
  others: { id: string; label: string } | null
  onSave: () => void
  onDiscard: () => void
  onUndo: () => void
  onShow: () => void
  onSwitch: (id: string) => void
  /** Reports the bar's height so the pane can pad for it on phones. */
  onHeight?: (px: number) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const visible = changes > 0 || state.kind !== "idle"
  React.useEffect(() => {
    const el = ref.current
    if (!el || !onHeight) return
    const ro = new ResizeObserver(() => onHeight(visible ? el.offsetHeight : 0))
    ro.observe(el)
    onHeight(visible ? el.offsetHeight : 0)
    return () => ro.disconnect()
  }, [onHeight, visible])

  // Cmd/Ctrl+S saves whenever something is unsaved.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        if (changes > 0 && state.kind !== "saving") onSave()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [changes, state.kind, onSave])

  if (!visible) return <div ref={ref} hidden />

  const saving = state.kind === "saving"
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  const files = (fs: string[]) => fs.join(" and ") || "config/runway.yaml"

  let status: React.ReactNode
  let detail: React.ReactNode = null
  let actions: React.ReactNode = null
  const saveButton = (
    <Button
      size="sm"
      onClick={onSave}
      disabled={saving || changes === 0}
      title={`Save (${mac ? "⌘" : "Ctrl+"}S)`}
      className="max-xl:h-11 max-xl:px-5"
    >
      {saving ? <Loader2 className="animate-spin" /> : null}
      {saving ? "Saving…" : "Save"}
    </Button>
  )
  const discardButton = (
    <Button
      size="sm"
      variant="ghost"
      onClick={onDiscard}
      disabled={saving}
      className="max-xl:h-11"
    >
      Discard
    </Button>
  )

  switch (state.kind) {
    case "saving":
      status = (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 size={13} className="animate-spin" /> Saving to{" "}
          {files(state.files)}…
        </span>
      )
      actions = (
        <>
          {discardButton}
          {saveButton}
        </>
      )
      break
    case "saved":
      status = (
        <span className="inline-flex items-center gap-1.5">
          <Check size={13} className="text-emerald-600 dark:text-emerald-400" />{" "}
          Saved to {files(state.files)}
        </span>
      )
      break
    case "discarded":
      status = `Discarded ${plural(state.n, "change")}.`
      actions = (
        <Button
          size="sm"
          variant="outline"
          onClick={onUndo}
          className="max-xl:h-11"
        >
          Undo
        </Button>
      )
      break
    case "invalid":
      status = (
        <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
          <AlertTriangle size={13} /> Couldn't save:{" "}
          {plural(state.issues.length, "problem")}
        </span>
      )
      detail = state.unmapped.length ? (
        <span className="flex flex-col font-mono text-[11px]">
          {state.unmapped.slice(0, 3).map((i) => (
            <span key={`${i.path}-${i.message}`} className="truncate">
              {i.path}: {i.message}
            </span>
          ))}
          {state.unmapped.length > 3 ? (
            <span>and {state.unmapped.length - 3} more</span>
          ) : null}
        </span>
      ) : null
      actions = (
        <>
          {state.issues.length > state.unmapped.length ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onShow}
              className="max-xl:h-11"
            >
              Show
            </Button>
          ) : null}
          {discardButton}
          {saveButton}
        </>
      )
      break
    case "unreachable":
      status = (
        <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
          <AlertTriangle size={13} /> Couldn't reach the ledger server. Your
          edits are still here.
        </span>
      )
      actions = saveButton
      break
    case "conflict":
    case "failed":
      status = (
        <span className="inline-flex items-start gap-1.5 text-rose-600 dark:text-rose-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{" "}
          {state.message}
        </span>
      )
      actions = (
        <>
          {discardButton}
          {saveButton}
        </>
      )
      break
    default:
      status = (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-1.5 rounded-full bg-primary"
            aria-hidden="true"
          />
          {plural(changes, "unsaved change")}
        </span>
      )
      detail = stale
        ? `${stale} changed since you started editing. Save writes only the fields you changed.`
        : restored
          ? "Restored from your last visit."
          : targets
      actions = (
        <>
          {discardButton}
          {saveButton}
        </>
      )
  }

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        "z-20 flex flex-col gap-1 border-t px-4 pt-2.5 text-xs duration-150 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:slide-in-from-bottom-0",
        "max-xl:fixed max-xl:inset-x-0 max-xl:bottom-0 max-xl:bg-background/95 max-xl:pb-[calc(0.625rem+env(safe-area-inset-bottom))] max-xl:backdrop-blur",
        "xl:sticky xl:bottom-0 xl:-mx-4 xl:mt-auto xl:rounded-b-xl xl:bg-[inherit] xl:pb-2.5"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          aria-live="polite"
          className="flex min-w-0 flex-1 flex-col gap-0.5"
        >
          <span className="min-w-0">{status}</span>
          {detail ? (
            <span className="truncate text-muted-foreground">{detail}</span>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {others && state.kind === "idle" ? (
        <span className="text-muted-foreground">
          {others.label} also has unsaved changes.{" "}
          <button
            type="button"
            onClick={() => onSwitch(others.id)}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Switch
          </button>
        </span>
      ) : null}
    </div>
  )
}
