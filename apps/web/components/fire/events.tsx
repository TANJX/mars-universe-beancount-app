"use client"

// Life events: each one toggles on/off, moves by year, and carries the one or
// two numbers its kind needs. They show on the chart as markers. Pay and
// equity belong to jobs and are edited in People.

import { Plus, Trash2 } from "lucide-react"

import type { EventKind, FireEvent, Inputs } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { NumberField, SectionCard, Toggle, YearStepper } from "./controls"

const KIND_LABEL: Record<EventKind, string> = {
  lump: "Lump sum",
  marker: "Milestone",
  kid: "Child",
  japan: "Abroad",
  crash: "Crash",
}

function blank(kind: EventKind, year: number, inputs: Inputs): FireEvent {
  const id = `${kind}-${year}-${inputs.events.length}`
  const base = { id, year, enabled: true }
  switch (kind) {
    case "lump":
      return { ...base, kind, label: "One-off", amount: -10000 }
    case "marker":
      return { ...base, kind, label: "Milestone" }
    case "kid":
      return { ...base, kind, label: "Child" }
    case "japan":
      return { ...base, kind, label: "Abroad", years: 2, netSaving: 0 }
    case "crash":
      return { ...base, kind, label: "Market crash", drop: 0.4 }
  }
}

export function EventsPanel({
  inputs,
  onChange,
}: {
  inputs: Inputs
  onChange: (events: FireEvent[]) => void
}) {
  const events = [...inputs.events].sort((a, b) => a.year - b.year)
  const set = (id: string, patch: Partial<FireEvent>) =>
    onChange(
      inputs.events.map((e) =>
        e.id === id ? ({ ...e, ...patch } as FireEvent) : e
      )
    )
  const remove = (id: string) =>
    onChange(inputs.events.filter((e) => e.id !== id))
  const add = (kind: EventKind) =>
    onChange([...inputs.events, blank(kind, inputs.startYear + 2, inputs)])

  return (
    <SectionCard
      title="Life events"
      hint="Toggle, move, and size each event. Disabled events stay listed for later. Pay changes live in People."
    >
      <div className="flex flex-col divide-y text-xs">
        {events.map((e) => (
          <div
            key={e.id}
            className={cn(
              "grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2 @2xl:grid-cols-[auto_minmax(10rem,1fr)_7.5rem_minmax(0,1.6fr)_auto]",
              !e.enabled && "text-muted-foreground"
            )}
          >
            <Toggle
              checked={e.enabled}
              onChange={(v) => set(e.id, { enabled: v })}
              label={`Enable ${e.label}`}
            />
            <div className="flex min-w-0 flex-col">
              <input
                aria-label="Event label"
                value={e.label}
                onChange={(x) => set(e.id, { label: x.target.value })}
                className="truncate bg-transparent font-medium outline-none"
              />
              <span className="text-[10.5px] text-muted-foreground">
                {KIND_LABEL[e.kind]}
              </span>
            </div>
            <YearStepper
              value={e.year}
              onChange={(y) => set(e.id, { year: y })}
            />
            <div className="col-span-3 flex flex-wrap items-center gap-2 @2xl:col-span-1">
              <EventParams event={e} set={(p) => set(e.id, p)} />
            </div>
            <button
              type="button"
              aria-label={`Remove ${e.label}`}
              onClick={() => remove(e.id)}
              className="hidden rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground @2xl:block"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {(Object.keys(KIND_LABEL) as EventKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => add(k)}
            className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus size={11} />
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
    </SectionCard>
  )
}

function EventParams({
  event: e,
  set,
}: {
  event: FireEvent
  set: (patch: Partial<FireEvent>) => void
}) {
  switch (e.kind) {
    case "lump":
      return (
        <>
          <NumberField
            ariaLabel="Amount"
            prefix="$"
            className="w-28"
            value={e.amount}
            onChange={(v) => set({ amount: v } as Partial<FireEvent>)}
          />
          <span className="text-muted-foreground">negative = cost</span>
        </>
      )
    case "japan":
      return (
        <>
          <NumberField
            ariaLabel="Years"
            className="w-14"
            suffix="yr"
            value={e.years}
            onChange={(v) =>
              set({ years: Math.max(1, Math.round(v)) } as Partial<FireEvent>)
            }
          />
          <NumberField
            ariaLabel="Net saving per year"
            prefix="$"
            className="w-24"
            value={e.netSaving}
            onChange={(v) => set({ netSaving: v } as Partial<FireEvent>)}
          />
          <span className="text-muted-foreground">
            net saving / yr (negative = drawing down)
          </span>
        </>
      )
    case "crash":
      return (
        <>
          <NumberField
            ariaLabel="Drop"
            className="w-16"
            suffix="%"
            value={Math.round(e.drop * 100)}
            onChange={(v) =>
              set({
                drop: Math.min(0.9, Math.max(0, v / 100)),
              } as Partial<FireEvent>)
            }
          />
          <span className="text-muted-foreground">one-year portfolio drop</span>
        </>
      )
    case "kid":
      return (
        <span className="text-muted-foreground">
          Costs from the kid cost bands (birth year)
        </span>
      )
    case "marker":
      return <span className="text-muted-foreground">Timeline marker only</span>
  }
}
