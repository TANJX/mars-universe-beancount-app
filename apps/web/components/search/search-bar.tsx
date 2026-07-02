"use client"

import { Command as CommandPrimitive } from "cmdk"
import {
  FolderMinus,
  FolderTree,
  Hash,
  Link as LinkIcon,
  Search,
  TextCursorInput,
  User,
  X,
} from "lucide-react"
import * as React from "react"

import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  addToken,
  parseSearch,
  removeToken,
  type SearchQuery,
  stringifySearch,
} from "@/lib/search/parse"
import type { SearchVocabulary } from "@/lib/search/vocabulary"

export type Prefix = "account" | "exclude:account" | "tag" | "link" | "payee"
export type ChipKind = Prefix | "text"

interface Chip {
  id: string
  kind: ChipKind
  value: string
  pinned?: boolean
}

interface PrefixMeta {
  label: string
  syntax: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  vocabKey?: keyof SearchVocabulary
  glyph?: string
}

const PREFIX_META: Record<ChipKind, PrefixMeta> = {
  account: {
    label: "Account",
    syntax: "account:",
    icon: FolderTree,
    vocabKey: "accounts",
  },
  "exclude:account": {
    label: "Not in account",
    syntax: "exclude:account:",
    icon: FolderMinus,
    vocabKey: "accounts",
  },
  tag: {
    label: "Tag",
    syntax: "tag:",
    icon: Hash,
    vocabKey: "tags",
    glyph: "#",
  },
  link: {
    label: "Link",
    syntax: "link:",
    icon: LinkIcon,
    vocabKey: "links",
    glyph: "^",
  },
  payee: {
    label: "Payee",
    syntax: "payee:",
    icon: User,
    vocabKey: "payees",
  },
  text: {
    label: "Text",
    syntax: "",
    icon: TextCursorInput,
  },
}

const PICKER_PREFIXES: Prefix[] = [
  "account",
  "tag",
  "link",
  "payee",
  "exclude:account",
]

type Builder =
  | { state: "idle"; draft: string }
  | { state: "value"; prefix: Prefix; draft: string }

function parsedToChips(q: SearchQuery, pinnedAccount?: string): Chip[] {
  const out: Chip[] = []
  if (pinnedAccount) {
    out.push({
      id: `pinned:${pinnedAccount}`,
      kind: "account",
      value: pinnedAccount,
      pinned: true,
    })
  }
  q.accounts.forEach((v, i) => {
    if (v === pinnedAccount) return
    out.push({ id: `a:${i}:${v}`, kind: "account", value: v })
  })
  q.excludeAccounts.forEach((v, i) => {
    out.push({ id: `xa:${i}:${v}`, kind: "exclude:account", value: v })
  })
  q.payees.forEach((v, i) => {
    out.push({ id: `p:${i}:${v}`, kind: "payee", value: v })
  })
  q.tags.forEach((v, i) => {
    out.push({ id: `t:${i}:${v}`, kind: "tag", value: v })
  })
  q.links.forEach((v, i) => {
    out.push({ id: `l:${i}:${v}`, kind: "link", value: v })
  })
  q.text.forEach((v, i) => {
    out.push({ id: `tx:${i}:${v}`, kind: "text", value: v })
  })
  return out
}

interface SearchBarProps {
  /** Current `?q=` value. SearchQuery shape is derived internally. */
  value: string
  onChange: (next: string) => void
  vocabulary: SearchVocabulary
  /** URL-pinned account (`?account=`). Rendered as the leftmost accent chip. */
  accountFilter?: string
  /** Called when the user removes the pinned account chip. */
  onClearAccount?: () => void
  matchedCount?: number
  totalCount?: number
  /** Trailing label for the count, e.g. "txns" or "rows". */
  countLabel?: string
}

export function SearchBar({
  value,
  onChange,
  vocabulary,
  accountFilter,
  onClearAccount,
  matchedCount,
  totalCount,
  countLabel,
}: SearchBarProps) {
  const parsed = React.useMemo(() => parseSearch(value), [value])
  const chips = React.useMemo(
    () => parsedToChips(parsed, accountFilter),
    [parsed, accountFilter]
  )

  const [builder, setBuilder] = React.useState<Builder>({
    state: "idle",
    draft: "",
  })
  const [focused, setFocused] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const chipRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  const open = focused
  const draft = builder.draft

  const commitChip = React.useCallback(
    (kind: ChipKind, val: string) => {
      const v = val.trim()
      if (!v) return
      onChange(stringifySearch(addToken(parsed, { kind, value: v })))
      setBuilder({ state: "idle", draft: "" })
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [parsed, onChange]
  )

  const removeChipAt = React.useCallback(
    (idx: number) => {
      const c = chips[idx]
      if (!c) return
      if (c.pinned) {
        onClearAccount?.()
        return
      }
      onChange(
        stringifySearch(removeToken(parsed, { kind: c.kind, value: c.value }))
      )
    },
    [chips, parsed, onChange, onClearAccount]
  )

  const editChipAt = React.useCallback(
    (idx: number) => {
      const c = chips[idx]
      if (!c || c.pinned) return
      onChange(
        stringifySearch(removeToken(parsed, { kind: c.kind, value: c.value }))
      )
      if (c.kind === "text") {
        setBuilder({ state: "idle", draft: c.value })
      } else {
        setBuilder({ state: "value", prefix: c.kind, draft: c.value })
      }
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [chips, parsed, onChange]
  )

  function focusChip(idx: number) {
    chipRefs.current[idx]?.focus()
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return

    if (e.key === "Escape") {
      if (builder.state === "value") {
        e.preventDefault()
        setBuilder({ state: "idle", draft: builder.draft })
        return
      }
      e.preventDefault()
      inputRef.current?.blur()
      return
    }

    if (e.key === "Backspace" && draft === "") {
      if (builder.state === "value") {
        e.preventDefault()
        setBuilder({ state: "idle", draft: "" })
        return
      }
      if (chips.length > 0) {
        e.preventDefault()
        focusChip(chips.length - 1)
        return
      }
    }

    if (
      e.key === "ArrowLeft" &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0 &&
      chips.length > 0
    ) {
      e.preventDefault()
      focusChip(chips.length - 1)
      return
    }
  }

  function onChipKeyDown(
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) {
    if (e.nativeEvent.isComposing) return

    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      removeChipAt(idx)
      const newLen = chips.length - 1
      if (newLen === 0) {
        inputRef.current?.focus()
      } else if (idx >= newLen) {
        focusChip(newLen - 1)
      } else {
        focusChip(idx)
      }
      return
    }

    if (e.key === "Enter") {
      e.preventDefault()
      const c = chips[idx]
      if (c?.pinned) {
        inputRef.current?.focus()
        return
      }
      editChipAt(idx)
      return
    }

    if (e.key === "ArrowLeft") {
      if (idx > 0) {
        e.preventDefault()
        focusChip(idx - 1)
      }
      return
    }

    if (e.key === "ArrowRight") {
      e.preventDefault()
      if (idx < chips.length - 1) {
        focusChip(idx + 1)
      } else {
        inputRef.current?.focus()
      }
      return
    }

    if (e.key === "Escape") {
      e.preventDefault()
      inputRef.current?.focus()
      return
    }

    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      inputRef.current?.focus()
      setBuilder((b) => ({ ...b, draft: b.draft + e.key }))
    }
  }

  function onRootFocus() {
    setFocused(true)
  }

  function onRootBlur(e: React.FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null
    if (next && rootRef.current?.contains(next)) return
    setFocused(false)
  }

  return (
    <CommandPrimitive shouldFilter={false} loop className="contents">
      <div
        ref={rootRef}
        onFocus={onRootFocus}
        onBlur={onRootBlur}
        className="relative"
      >
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5">
          <Search size={14} className="shrink-0 text-muted-foreground" />

          {chips.map((c, idx) => (
            <ChipPill
              key={c.id}
              ref={(el) => {
                chipRefs.current[idx] = el
              }}
              chip={c}
              onClickRemove={() => {
                removeChipAt(idx)
                inputRef.current?.focus()
              }}
              onKeyDown={(e) => onChipKeyDown(e, idx)}
            />
          ))}

          {builder.state === "value" && (
            <span className="inline-flex h-5 items-center gap-1 rounded-md bg-primary/10 px-1.5 text-xs text-primary">
              {React.createElement(PREFIX_META[builder.prefix].icon, {
                size: 11,
                className: "shrink-0",
              })}
              <span className="font-mono">
                {PREFIX_META[builder.prefix].syntax}
              </span>
            </span>
          )}

          <CommandPrimitive.Input
            ref={inputRef}
            value={draft}
            onValueChange={(v) => {
              // Shortcut: `^` and `#` from an empty idle draft jump
              // straight into the link / tag builder (fava's URL-filter
              // glyphs). Also supports paste like `^abc` → builder open
              // with `abc` pre-filled. Mid-query glyphs are preserved by
              // the empty-draft gate.
              if (builder.state === "idle" && builder.draft === "") {
                if (v.startsWith("^")) {
                  setBuilder({
                    state: "value",
                    prefix: "link",
                    draft: v.slice(1),
                  })
                  return
                }
                if (v.startsWith("#")) {
                  setBuilder({
                    state: "value",
                    prefix: "tag",
                    draft: v.slice(1),
                  })
                  return
                }
              }
              setBuilder((b) => ({ ...b, draft: v }))
            }}
            onKeyDown={onInputKeyDown}
            placeholder={
              chips.length === 0 && builder.state === "idle"
                ? "Filter by account, tag, link, payee… or just type to search"
                : ""
            }
            data-search="primary"
            className="min-w-36 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />

          {typeof matchedCount === "number" && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
              {typeof totalCount === "number"
                ? `${matchedCount} of ${totalCount}${countLabel ? ` ${countLabel}` : ""}`
                : `${matchedCount}${countLabel ? ` ${countLabel}` : ""}`}
            </span>
          )}
        </div>

        {open && (
          <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <DropdownBody
              builder={builder}
              vocabulary={vocabulary}
              onPickPrefix={(p) =>
                setBuilder({ state: "value", prefix: p, draft: "" })
              }
              onPickValue={(v) => {
                if (builder.state === "value") commitChip(builder.prefix, v)
              }}
              onCommitText={(v) => commitChip("text", v)}
            />
            <HintRow />
          </div>
        )}
      </div>
    </CommandPrimitive>
  )
}

function DropdownBody({
  builder,
  vocabulary,
  onPickPrefix,
  onPickValue,
  onCommitText,
}: {
  builder: Builder
  vocabulary: SearchVocabulary
  onPickPrefix: (p: Prefix) => void
  onPickValue: (v: string) => void
  onCommitText: (v: string) => void
}) {
  const draft = builder.draft.trim()
  const draftLc = draft.toLowerCase()

  if (builder.state === "idle") {
    const prefixMatches = PICKER_PREFIXES.filter((p) => {
      if (!draftLc) return true
      return (
        p.toLowerCase().startsWith(draftLc) ||
        PREFIX_META[p].label.toLowerCase().startsWith(draftLc)
      )
    })

    return (
      <CommandList>
        {prefixMatches.length === 0 && draft.length === 0 && (
          <CommandEmpty>No matches.</CommandEmpty>
        )}

        {prefixMatches.length > 0 && (
          <CommandGroup heading="Field">
            {prefixMatches.map((p) => {
              const meta = PREFIX_META[p]
              return (
                <CommandItem
                  key={p}
                  value={`prefix-${p}`}
                  onSelect={() => onPickPrefix(p)}
                >
                  <meta.icon size={14} className="shrink-0" />
                  <span className="font-mono text-xs text-muted-foreground">
                    {meta.syntax}
                  </span>
                  <span>{meta.label}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {draft.length > 0 && (
          <CommandGroup heading="Search">
            <CommandItem
              value={`text-${draft}`}
              onSelect={() => onCommitText(draft)}
            >
              <Search size={14} className="shrink-0" />
              <span className="text-muted-foreground">Search text:</span>
              <span className="truncate">{draft}</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    )
  }

  const meta = PREFIX_META[builder.prefix]
  const pool: string[] = meta.vocabKey ? vocabulary[meta.vocabKey] : []
  const matches = draftLc
    ? pool.filter((v) => v.toLowerCase().includes(draftLc)).slice(0, 60)
    : pool.slice(0, 60)

  const exactMatch = pool.some((v) => v.toLowerCase() === draftLc)

  return (
    <CommandList>
      {matches.length === 0 && draft.length === 0 && (
        <CommandEmpty>No suggestions yet.</CommandEmpty>
      )}

      {matches.length > 0 && (
        <CommandGroup heading={meta.label}>
          {matches.map((v) => (
            <CommandItem
              key={v}
              value={`val-${v}`}
              onSelect={() => onPickValue(v)}
            >
              {meta.glyph ? (
                <span className="font-mono text-muted-foreground">
                  {meta.glyph}
                </span>
              ) : (
                <meta.icon size={14} className="shrink-0" />
              )}
              <ValueDisplay kind={builder.prefix} value={v} draft={draftLc} />
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {draft.length > 0 && !exactMatch && (
        <CommandGroup heading="Use as written">
          <CommandItem
            key="__as-written"
            value={`asw-${draft}`}
            onSelect={() => onPickValue(draft)}
          >
            <meta.icon size={14} className="shrink-0" />
            <span className="font-mono text-xs text-muted-foreground">
              {meta.syntax}
            </span>
            <span>{draft}</span>
          </CommandItem>
        </CommandGroup>
      )}
    </CommandList>
  )
}

function ValueDisplay({
  kind,
  value,
  draft,
}: {
  kind: Prefix
  value: string
  draft: string
}) {
  if (kind === "account" || kind === "exclude:account") {
    const segs = value.split(":")
    const last = segs[segs.length - 1]
    const head = segs.slice(0, -1).join(":")
    return (
      <span className="min-w-0 truncate font-mono text-sm">
        {head && <span className="text-muted-foreground/70">{head}:</span>}
        <span className="text-foreground">
          <Highlight text={last} draft={draft} />
        </span>
      </span>
    )
  }
  return (
    <span className="min-w-0 truncate">
      <Highlight text={value} draft={draft} />
    </span>
  )
}

function Highlight({ text, draft }: { text: string; draft: string }) {
  if (!draft) return <>{text}</>
  const lower = text.toLowerCase()
  const idx = lower.indexOf(draft)
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">
        {text.slice(idx, idx + draft.length)}
      </mark>
      {text.slice(idx + draft.length)}
    </>
  )
}

function HintRow() {
  return (
    <div className="flex items-center gap-3 border-t bg-muted/30 px-3 py-1.5 text-[10px] tracking-wide text-muted-foreground">
      <span>
        <kbd className="font-mono">↑↓</kbd> navigate
      </span>
      <span>
        <kbd className="font-mono">↵</kbd> select
      </span>
      <span>
        <kbd className="font-mono">esc</kbd> back
      </span>
      <span>
        <kbd className="font-mono">⌫</kbd> remove chip
      </span>
    </div>
  )
}

interface ChipPillProps {
  chip: Chip
  onClickRemove: () => void
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>
}

const ChipPill = React.forwardRef<HTMLButtonElement, ChipPillProps>(
  function ChipPill({ chip, onClickRemove, onKeyDown }, ref) {
    const meta = PREFIX_META[chip.kind]
    const Icon = meta.icon
    // `pinned` (URL `?account=` provenance) still controls the × handler
    // dispatch in `removeChipAt`, but no longer changes the chip's look:
    // a single account filter is a single account filter regardless of
    // which URL slot it lives in.
    return (
      <button
        ref={ref}
        type="button"
        onKeyDown={onKeyDown}
        className="group inline-flex h-5 items-center gap-1 rounded-md border border-transparent bg-secondary px-1.5 text-xs text-secondary-foreground outline-none focus-visible:border-primary/50 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/20"
      >
        <Icon size={11} className="shrink-0 opacity-70" />
        {chip.kind === "text" ? (
          <span className="truncate">{chip.value}</span>
        ) : (
          <span className="truncate font-mono">
            <span className="opacity-70">{meta.syntax}</span>
            {meta.glyph && <span className="opacity-70">{meta.glyph}</span>}
            <span>{chip.value}</span>
          </span>
        )}
        <span
          role="button"
          tabIndex={-1}
          aria-label="Remove filter"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onClickRemove()
          }}
          className="ml-0.5 inline-flex shrink-0 cursor-pointer opacity-60 hover:opacity-100"
        >
          <X size={10} />
        </span>
      </button>
    )
  }
)
