"use client"

// "Where the money goes" (the sleeves in the order money flows through
// them), the not-modeled list, and the empty state for a person whose plan
// can't be read.

import { AlertCircle, FileQuestion, Lock } from "lucide-react"

import { SectionCard, usd } from "@/components/fire/controls"
import { Button } from "@/components/ui/button"
import {
  NOT_MODELED_DEFAULT,
  SLEEVE_TEXT,
  SLEEVES,
  type SleeveId,
} from "@/lib/runway/sleeves"
import type { PersonStatus, SleeveText } from "@/lib/runway/types"

export interface SleeveInfo {
  id: SleeveId
  title: string
  body: string
}

export function sleeveInfos(
  overrides: Partial<Record<string, SleeveText>>,
  used: SleeveId[]
): SleeveInfo[] {
  return [...SLEEVES]
    .filter((s) => used.includes(s.id))
    .sort((a, b) => a.flow - b.flow)
    .map((s) => {
      const o = overrides[s.id]
      return {
        id: s.id,
        title: o?.title ?? SLEEVE_TEXT[s.id].title,
        body: o?.body ?? SLEEVE_TEXT[s.id].body,
      }
    })
}

export function SleeveExplainer({
  sleeves,
  endValues,
}: {
  sleeves: SleeveInfo[]
  endValues: Partial<Record<SleeveId, number>>
}) {
  return (
    <SectionCard
      title="Where the money goes"
      hint="Each sleeve's job, in the order money moves through them, with its balance at the end."
    >
      <div className="grid gap-2 @md:grid-cols-2">
        {sleeves.map((s, i) => {
          const def = SLEEVES.find((x) => x.id === s.id)
          return (
            <div
              key={s.id}
              className="flex flex-col gap-1 rounded-lg border p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-1.5 font-medium text-xs">
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{
                      background: def ? `var(${def.token})` : undefined,
                    }}
                  />
                  {s.title}
                </span>
                <span className="font-mono text-xs tabular-nums">
                  {usd(endValues[s.id] ?? 0)}
                </span>
              </div>
              <p className="max-w-[65ch] text-pretty text-muted-foreground text-xs">
                {s.body}
              </p>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

export function NotModeled({ items }: { items: string[] | null }) {
  const list = items?.length ? items : NOT_MODELED_DEFAULT
  return (
    <SectionCard title="Not modeled">
      <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground text-xs">
        {list.map((t) => (
          <li key={t} className="text-pretty">
            {t}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-muted-foreground text-xs">
        Planning model, not tax or financial advice.
      </p>
    </SectionCard>
  )
}

export function PersonStatusState({
  name,
  status,
  file,
  message,
  onReload,
}: {
  name: string
  status: Exclude<PersonStatus, "ok">
  file?: string | null
  message?: string
  onReload: () => void
}) {
  const Icon =
    status === "locked"
      ? Lock
      : status === "missing"
        ? FileQuestion
        : AlertCircle
  const headline =
    status === "locked"
      ? `${name}'s plan is encrypted`
      : status === "missing"
        ? `No plan file for ${name}`
        : `Couldn't read ${name}'s plan`
  return (
    <div className="flex h-full min-h-[34dvh] flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      <Icon size={20} className="text-muted-foreground" />
      <div className="font-medium text-sm">{headline}</div>
      {status === "locked" ? (
        <p className="max-w-sm text-pretty text-muted-foreground text-xs">
          This file is locked by git-crypt. Unlock the ledger working copy, then
          reload.
        </p>
      ) : status === "missing" ? (
        <p className="max-w-sm text-pretty text-muted-foreground text-xs">
          Expected{" "}
          {file ? <code className="font-mono">{file}</code> : "a plan file"} in
          the ledger folder.
        </p>
      ) : (
        <p className="max-w-md whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
          {message}
        </p>
      )}
      {status === "locked" ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={onReload}
          className="mt-1"
        >
          Reload
        </Button>
      ) : null}
    </div>
  )
}
