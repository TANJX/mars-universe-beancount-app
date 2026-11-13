"use client"

// Scenario switching and management for one person: "Plan" (the base) and
// any number of named scenarios. Create, duplicate, rename and delete are
// staged edits like any other; Save writes them.
//
// The name form and the delete confirm open in a popover beside the actions
// button on wide screens and in a bottom sheet on phones (popovers fight the
// software keyboard there).

import {
  ChevronDown,
  Copy,
  GitBranch,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import * as React from "react"

import { Segmented } from "@/components/fire/controls"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { PLAN_ID } from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { FIELD } from "./fields"

export interface ScenarioOption {
  id: string
  label: string
}

type Mode =
  | { kind: "new"; from: string }
  | { kind: "rename"; id: string }
  | { kind: "delete"; id: string }

const PHONE = "(max-width: 767px)"
const COARSE = "(pointer: coarse)"

function useMedia(query: string): boolean {
  const [on, setOn] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  )
  React.useEffect(() => {
    const mq = window.matchMedia(query)
    const fn = () => setOn(mq.matches)
    mq.addEventListener("change", fn)
    return () => mq.removeEventListener("change", fn)
  }, [query])
  return on
}

export function ScenarioBar({
  scenarios,
  activeId,
  onSelect,
  readOnly,
  nameError,
  changesIn,
  onCreate,
  onRename,
  onDelete,
}: {
  /** Plan first, then the person's scenarios in config order. */
  scenarios: ScenarioOption[]
  activeId: string
  onSelect: (id: string) => void
  readOnly: boolean
  /** Why a name is not acceptable (null when fine). */
  nameError: (label: string, selfId?: string) => string | null
  /** Settings a scenario changes from Plan. */
  changesIn: (id: string) => number
  onCreate: (label: string, fromId: string) => void
  onRename: (id: string, label: string) => void
  onDelete: (id: string) => void
}) {
  const [mode, setMode] = React.useState<Mode | null>(null)
  const actionsRef = React.useRef<HTMLButtonElement>(null)
  const phone = useMedia(PHONE)
  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0]
  const onPlan = activeId === PLAN_ID

  const close = () => {
    setMode(null)
    // Back to the actions button once the popup has gone.
    setTimeout(() => actionsRef.current?.focus(), 0)
  }

  const body = mode ? (
    mode.kind === "delete" ? (
      <DeleteConfirm
        label={scenarios.find((s) => s.id === mode.id)?.label ?? mode.id}
        changes={changesIn(mode.id)}
        onCancel={close}
        onConfirm={() => {
          onDelete(mode.id)
          setMode(null)
        }}
      />
    ) : (
      <ScenarioForm
        mode={mode}
        fromLabel={
          mode.kind === "new" && mode.from !== PLAN_ID
            ? (scenarios.find((s) => s.id === mode.from)?.label ?? null)
            : null
        }
        initial={
          mode.kind === "rename"
            ? (scenarios.find((s) => s.id === mode.id)?.label ?? "")
            : ""
        }
        nameError={(v) =>
          nameError(v, mode.kind === "rename" ? mode.id : undefined)
        }
        onCancel={close}
        onSubmit={(label) => {
          if (mode.kind === "rename") onRename(mode.id, label)
          else onCreate(label, mode.from)
          setMode(null)
        }}
      />
    )
  ) : null

  const switcher =
    scenarios.length <= 3 ? (
      <Segmented<string>
        ariaLabel="Scenario"
        value={active?.id ?? PLAN_ID}
        onChange={onSelect}
        options={scenarios.map((s) => ({
          value: s.id,
          label: (
            <span className="block max-w-40 truncate" title={s.label}>
              {s.label}
            </span>
          ),
        }))}
        className="h-9 min-w-0 flex-1 md:h-7 md:flex-none"
        optionClassName="min-w-0 flex-1 md:flex-none"
      />
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Scenario"
          className={cn(
            "inline-flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 font-medium md:max-w-56 md:flex-none",
            FIELD,
            "md:w-auto"
          )}
        >
          <span className="truncate">{active?.label}</span>
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-48">
          <DropdownMenuRadioGroup
            value={active?.id}
            onValueChange={(v) => onSelect(String(v))}
          >
            {scenarios.map((s) => (
              <DropdownMenuRadioItem key={s.id} value={s.id}>
                {s.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )

  return (
    <span className="inline-flex w-full min-w-0 items-center gap-1 md:w-auto">
      {switcher}
      {readOnly ? null : (
        <span className="relative">
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={actionsRef}
              aria-label="Scenario actions"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="relative size-9 before:absolute before:-inset-1 md:size-7"
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-52">
              <DropdownMenuItem
                onClick={() => setMode({ kind: "new", from: PLAN_ID })}
              >
                <Plus /> {onPlan ? "New scenario" : "New scenario from Plan"}
              </DropdownMenuItem>
              {onPlan || !active ? null : (
                <>
                  <DropdownMenuItem
                    onClick={() => setMode({ kind: "new", from: active.id })}
                  >
                    <Copy /> Duplicate "{active.label}"
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setMode({ kind: "rename", id: active.id })}
                  >
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setMode({ kind: "delete", id: active.id })}
                  >
                    <Trash2 /> Delete scenario
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {phone ? (
            <Sheet
              open={mode != null}
              onOpenChange={(o) => (o ? null : close())}
            >
              <SheetContent
                side="bottom"
                className="gap-0 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
              >
                {body}
              </SheetContent>
            </Sheet>
          ) : (
            <Popover
              open={mode != null}
              onOpenChange={(o) => (o ? null : close())}
            >
              <PopoverTrigger
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute inset-0 opacity-0"
              />
              <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
                {body}
              </PopoverContent>
            </Popover>
          )}
        </span>
      )}
    </span>
  )
}

function ScenarioForm({
  mode,
  fromLabel,
  initial,
  nameError,
  onCancel,
  onSubmit,
}: {
  mode: Exclude<Mode, { kind: "delete" }>
  fromLabel: string | null
  initial: string
  nameError: (label: string) => string | null
  onCancel: () => void
  onSubmit: (label: string) => void
}) {
  const id = React.useId()
  const [value, setValue] = React.useState(initial)
  const [error, setError] = React.useState<string | null>(null)
  const coarse = useMedia(COARSE)
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    // Autofocus only with a fine pointer: on touch the keyboard would cover
    // the sheet before the person chose to type.
    if (coarse) return
    const el = inputRef.current
    el?.focus()
    if (mode.kind === "rename") el?.select()
  }, [coarse, mode.kind])
  const title =
    mode.kind === "rename"
      ? "Rename scenario"
      : fromLabel
        ? "Duplicate scenario"
        : "New scenario"
  const subtitle =
    mode.kind === "rename"
      ? null
      : `Starts as a copy of ${fromLabel ?? "Plan"}.`
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        const err = nameError(value)
        setError(err)
        if (!err) onSubmit(value)
      }}
    >
      <div className="flex flex-col gap-0.5">
        <SheetOrPopoverTitle>{title}</SheetOrPopoverTitle>
        {subtitle ? (
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-xs">
          Name
        </label>
        <input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(nameError(e.target.value))
          }}
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className={cn(
            "rounded-md border border-input bg-transparent px-2 outline-none focus-visible:border-ring aria-invalid:border-rose-500 dark:bg-input/30",
            FIELD
          )}
        />
        {error ? (
          <span
            id={`${id}-err`}
            className="text-rose-600 text-xs dark:text-rose-400"
          >
            {error}
          </span>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {mode.kind === "rename" ? "Save name" : "Create"}
        </Button>
      </div>
    </form>
  )
}

function DeleteConfirm({
  label,
  changes,
  onCancel,
  onConfirm,
}: {
  label: string
  changes: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => cancelRef.current?.focus(), [])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SheetOrPopoverTitle>Delete "{label}"?</SheetOrPopoverTitle>
        <p className="text-muted-foreground text-xs">
          {changes > 0
            ? `Its ${changes} ${changes === 1 ? "change" : "changes"} from Plan go with it.`
            : "It has no changes from Plan yet."}{" "}
          You can still Discard before saving.
        </p>
      </div>
      <div className="flex justify-between gap-4">
        <Button
          ref={cancelRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={onConfirm}
        >
          Delete scenario
        </Button>
      </div>
    </div>
  )
}

/** A heading that is the sheet's accessible title on phones and a plain
 * heading in the popover. */
function SheetOrPopoverTitle({ children }: { children: React.ReactNode }) {
  const phone = useMedia(PHONE)
  return phone ? (
    <SheetTitle className="font-medium text-sm">{children}</SheetTitle>
  ) : (
    <h2 className="font-medium text-sm">{children}</h2>
  )
}

/** Top of the pane: which target edits go to. */
export function ScenarioNote({
  label,
  isPlan,
  changes,
  hasScenarios,
  onEditPlan,
}: {
  label: string
  isPlan: boolean
  changes: number
  hasScenarios: boolean
  onEditPlan: () => void
}) {
  if (isPlan)
    return hasScenarios ? (
      <p className="px-1 text-muted-foreground text-xs">
        Editing Plan. Scenarios follow Plan except where they change a setting.
      </p>
    ) : null
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-muted-foreground text-xs">
      <GitBranch size={13} className="mt-px shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Editing <span className="font-medium text-foreground">{label}</span>.
        Changes here apply to this scenario only;{" "}
        {changes > 0
          ? `${changes} ${changes === 1 ? "setting differs" : "settings differ"} from Plan.`
          : "it matches Plan so far."}{" "}
        <button
          type="button"
          onClick={onEditPlan}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          Edit Plan
        </button>
      </p>
    </div>
  )
}

export function ReadOnlyBanner({ file }: { file: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-muted-foreground text-xs">
      <Lock size={13} className="mt-px shrink-0" aria-hidden="true" />
      <p>
        Read-only. <span className="font-mono">{file}</span> can't be written
        here, so edits are off.
      </p>
    </div>
  )
}
