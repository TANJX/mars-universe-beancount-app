"use client"

// The shared `defaults:` settings every person starts from. A person can
// override any of them on their own page; each field says who does, so an
// edit here is honest about whom it reaches.

import { Plus, Users, X } from "lucide-react"
import * as React from "react"

import {
  NumberField,
  pct,
  Segmented,
  SliderRow,
  usd,
} from "@/components/fire/controls"
import { getPath } from "@/lib/runway/patch"
import type {
  LimitsGiven,
  SharedSettings,
  YearLimits,
} from "@/lib/runway/types"

import { EditedDot, FIELD, InputsSection, Markers, same } from "./fields"

export interface SharedPerson {
  label: string
  overrides: string[]
  /** The person's own value at a shared path. */
  value: (path: string) => unknown
}

const RETURNS = [
  ["equity", "Stocks", 0.12],
  ["reserve", "Reserve yield", 0.06],
  ["ef", "Savings (HYSA) yield", 0.06],
  ["gold", "Gold", 0.1],
] as const

const LIMIT_COLS: { key: keyof YearLimits; label: string }[] = [
  { key: "k401", label: "401k" },
  { key: "ira", label: "IRA" },
  { key: "hsaSelf", label: "HSA self" },
  { key: "hsaFamily", label: "HSA family" },
]

export function SharedSection({
  shared,
  saved,
  people,
  inScenario,
  onChange,
}: {
  shared: SharedSettings
  saved: SharedSettings
  people: SharedPerson[]
  inScenario: boolean
  onChange: (next: SharedSettings) => void
}) {
  const uid = React.useId()
  const names = people.map((p) => p.label)
  const title =
    names.length === 2
      ? `Shared by ${names[0]} and ${names[1]}`
      : names.length > 2
        ? `Shared by ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : "Shared defaults"

  const who = (path: string, fmt: (v: unknown) => string) => {
    const lines = people
      .filter((p) => p.overrides.includes(path))
      .map((p) => `${p.label} uses ${fmt(p.value(path))}.`)
    return lines.length ? lines.join(" ") : undefined
  }
  const fmtPct = (v: unknown) =>
    typeof v === "number" ? pct(v, 1) : "its own value"

  const years = Object.keys(shared.limits).sort()
  const setLimit = (y: string, key: keyof YearLimits, v: number | null) => {
    const row = { ...(shared.limits[y] ?? {}) }
    if (v == null) delete row[key]
    else row[key] = Math.max(0, v)
    const limits: LimitsGiven = { ...shared.limits, [y]: row }
    if (!Object.keys(row).length) delete limits[y]
    onChange({ ...shared, limits })
  }

  return (
    <InputsSection
      title={title}
      icon={<Users size={12} aria-hidden="true" />}
      hint="Defaults both people start from. A person can override any of these on their own page."
      summary={`stocks ${pct(shared.returns.equity, 1)} · play cap ${pct(shared.playCap, 0)} · spread to ${shared.spreadThrough === "horizon" ? "horizon" : "year end"}`}
    >
      {inScenario ? (
        <p className="text-muted-foreground text-xs @md:col-span-2">
          Shared settings are the same in every scenario.
        </p>
      ) : null}
      {RETURNS.map(([k, label, max]) => (
        <SliderRow
          key={k}
          label={label}
          value={shared.returns[k]}
          min={0}
          max={max}
          step={0.001}
          format={(v) => `${pct(v, 1)}/yr`}
          onChange={(v) =>
            onChange({ ...shared, returns: { ...shared.returns, [k]: v } })
          }
          hint={
            <>
              <Markers
                edited={shared.returns[k] !== saved.returns[k]}
                onReset={() =>
                  onChange({
                    ...shared,
                    returns: { ...shared.returns, [k]: saved.returns[k] },
                  })
                }
              />
              {who(`returns.${k}`, fmtPct)}
            </>
          }
        />
      ))}
      <SliderRow
        label="Play cap"
        info="The play sleeve's share of invested assets that the page flags as too much."
        value={shared.playCap}
        min={0}
        max={0.3}
        step={0.01}
        format={(v) => pct(v, 0)}
        onChange={(v) => onChange({ ...shared, playCap: v })}
        hint={
          <>
            <Markers
              edited={shared.playCap !== saved.playCap}
              onReset={() => onChange({ ...shared, playCap: saved.playCap })}
            />
            {who("playCap", (v) =>
              typeof v === "number" ? pct(v, 0) : "its own"
            )}
          </>
        }
      />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-xs">
          <span id={`${uid}-spread`}>Spread limits through</span>
          {shared.spreadThrough !== saved.spreadThrough ? (
            <EditedDot
              onReset={() =>
                onChange({ ...shared, spreadThrough: saved.spreadThrough })
              }
            />
          ) : null}
        </div>
        <Segmented<SharedSettings["spreadThrough"]>
          ariaLabel="Spread limits through"
          value={shared.spreadThrough}
          onChange={(v) => onChange({ ...shared, spreadThrough: v })}
          options={[
            { value: "year_end", label: "Year end" },
            { value: "horizon", label: "Horizon" },
          ]}
          className="h-9 w-full md:h-7 md:w-auto"
          optionClassName="flex-1 md:flex-none"
        />
        <span className="text-muted-foreground text-xs">
          {who("spreadThrough", (v) =>
            v === "horizon" ? "horizon" : "year end"
          ) ??
            "Pace even spreads the remaining limit over paychecks to Dec 31, or only those inside the plan."}
        </span>
      </div>

      <div className="flex flex-col gap-2 @md:col-span-2">
        <div className="flex items-center gap-1.5 text-xs">
          Annual limits
          {!same(shared.limits, saved.limits) ? (
            <EditedDot
              onReset={() => onChange({ ...shared, limits: saved.limits })}
            />
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          Only years you set here; the rest come from the bundled IRS table
          (catch-up added from birth year).
        </p>
        {years.map((y) => (
          <div
            key={y}
            className="flex flex-col gap-1.5 rounded-lg border px-3 py-2"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono tabular-nums">{y}</span>
              <button
                type="button"
                aria-label={`Remove ${y} limits`}
                onClick={() => {
                  const limits = { ...shared.limits }
                  delete limits[y]
                  onChange({ ...shared, limits })
                }}
                className="relative text-muted-foreground before:absolute before:-inset-2 hover:text-foreground pointer-coarse:before:-inset-3"
              >
                <X size={13} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
              {LIMIT_COLS.map((c) => {
                const v = shared.limits[y]?.[c.key]
                const path = `limits.${y}.${c.key}`
                return (
                  <label
                    key={c.key}
                    className="flex min-w-0 flex-col gap-1 text-xs"
                  >
                    <span className="text-muted-foreground">{c.label}</span>
                    {v == null ? (
                      <button
                        type="button"
                        onClick={() => setLimit(y, c.key, 0)}
                        className="h-9 rounded-md border border-dashed text-muted-foreground md:h-7"
                      >
                        IRS table
                      </button>
                    ) : (
                      <NumberField
                        ariaLabel={`${c.label} limit ${y}`}
                        prefix="$"
                        className={FIELD}
                        value={v}
                        onChange={(n) => setLimit(y, c.key, n)}
                      />
                    )}
                    {who(path, (x) =>
                      typeof x === "number" ? usd(x) : "its own"
                    ) ? (
                      <span className="text-muted-foreground">
                        {who(path, (x) =>
                          typeof x === "number" ? usd(x) : "its own"
                        )}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const last = years.at(-1)
            const y = String(last ? Number(last) + 1 : new Date().getFullYear())
            onChange({
              ...shared,
              limits: {
                ...shared.limits,
                [y]: { ...(last ? shared.limits[last] : {}) },
              },
            })
          }}
          className="inline-flex h-9 items-center gap-1.5 self-start text-muted-foreground text-xs hover:text-foreground md:h-7"
        >
          <Plus size={13} /> Add year
        </button>
      </div>
    </InputsSection>
  )
}

/** `value` for SharedPerson from a plan body. */
export const valueIn = (body: unknown) => (path: string) => getPath(body, path)
