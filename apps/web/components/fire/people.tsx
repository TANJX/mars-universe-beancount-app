"use client"

// One column per person: jobs (pay and equity), take-home, 401k deferral, starting
// net worth, and working-years spending. In individual mode only the primary
// person counts; the partner column is shown dimmed so their inputs are still
// one click away.

import { wagesFor } from "@/lib/fire/engine"
import { WORK_STATES } from "@/lib/fire/tax"
import type { Inputs, Person, Spending, WorkState } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { NumberField, pct, SectionCard, SliderRow, usd } from "./controls"
import { JobsEditor } from "./jobs"

const SPEND_FIELDS: { key: keyof Spending; label: string }[] = [
  { key: "housing", label: "Housing" },
  { key: "car", label: "Car" },
  { key: "discretionary", label: "Discretionary" },
  { key: "essentials", label: "Essentials" },
]

export function PeoplePanel({
  inputs,
  nowMonth,
  onChange,
}: {
  inputs: Inputs
  /** Snapshot month index, for "vested today". */
  nowMonth: number
  onChange: (people: Person[]) => void
}) {
  // Tax lines describe this year: the snapshot year's pay and brackets.
  const year = Math.floor(nowMonth / 12)
  const update = (i: number, patch: Partial<Person>) =>
    onChange(inputs.people.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <SectionCard
      title="People"
      hint="Working-years inputs in today's dollars. Each job carries its pay and equity; leaving a job stops both."
    >
      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
        {inputs.people.map((p, i) => {
          const inactive = inputs.mode === "individual" && i > 0
          const spend = SPEND_FIELDS.reduce((a, f) => a + p.spending[f.key], 0)
          return (
            <div
              key={p.id}
              className={cn(
                "flex flex-col gap-3 text-xs",
                inactive && "opacity-45"
              )}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-sm">{p.name}</span>
                <span className="text-muted-foreground">
                  born {p.birthYear}
                  {inactive ? " · not in individual mode" : ""}
                </span>
              </div>

              <JobsEditor
                person={p}
                startYear={inputs.startYear}
                nowMonth={nowMonth}
                onChange={(jobs) => update(i, { jobs })}
              />

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Works in</span>
                  <select
                    value={p.workState}
                    onChange={(e) =>
                      update(i, { workState: e.target.value as WorkState })
                    }
                    className="h-7 rounded-md border border-input bg-transparent px-1.5 dark:bg-input/30"
                  >
                    {WORK_STATES.map((w) => (
                      <option key={w.value} value={w.value}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    Starting net worth
                  </span>
                  {p.netWorth === "ledger" ? (
                    <span className="flex h-7 items-center text-muted-foreground">
                      from ledger
                    </span>
                  ) : (
                    <NumberField
                      ariaLabel={`${p.name} net worth`}
                      prefix="$"
                      value={p.netWorth}
                      onChange={(v) => update(i, { netWorth: v })}
                    />
                  )}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    Other income / yr
                  </span>
                  <NumberField
                    ariaLabel={`${p.name} other income`}
                    prefix="$"
                    value={p.otherIncome}
                    onChange={(v) => update(i, { otherIncome: v })}
                  />
                </label>
              </div>

              <SliderRow
                label="401k deferral (traditional)"
                value={p.k401Deferral}
                min={0}
                max={inputs.assumptions.k401Limit}
                step={500}
                format={usd}
                onChange={(v) => update(i, { k401Deferral: v })}
                hint={k401Hint(inputs, p, year)}
              />

              <TaxLine
                inputs={inputs}
                person={p}
                year={year}
                onPretax={(pretax) => update(i, { pretax })}
              />

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Spending while working
                  </span>
                  <span className="font-mono tabular-nums">
                    {usd(spend)} / yr
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {SPEND_FIELDS.map((f) => (
                    <label key={f.key} className="flex flex-col gap-1">
                      <span className="text-muted-foreground">{f.label}</span>
                      <NumberField
                        ariaLabel={`${p.name} ${f.label}`}
                        prefix="$"
                        value={p.spending[f.key]}
                        onChange={(v) =>
                          update(i, { spending: { ...p.spending, [f.key]: v } })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

function k401Hint(inputs: Inputs, p: Person, year: number): string {
  if (!p.k401Deferral)
    return "Pre-tax: lowers federal and state tax at your marginal rate."
  const without = {
    ...inputs,
    people: inputs.people.map((x) =>
      x.id === p.id ? { ...x, k401Deferral: 0 } : x
    ),
  }
  const t = (inp: Inputs) =>
    wagesFor(inp, year).taxes.find((x) => x.personId === p.id)?.total ?? 0
  const saved = t(without) - t(inputs)
  return `Costs ${usd(p.k401Deferral - saved)} of take-home and saves ${usd(saved)} of tax this year (${pct(saved / p.k401Deferral, 0)}).`
}

/** This year's tax at the person's current pay, from the bracket model. */
function TaxLine({
  inputs,
  person: p,
  year,
  onPretax,
}: {
  inputs: Inputs
  person: Person
  year: number
  onPretax: (pretax: Person["pretax"]) => void
}) {
  const update = (patch: Partial<Person["pretax"]>) =>
    onPretax({ ...p.pretax, ...patch })
  const pay = wagesFor(inputs, year)
  const t = pay.taxes.find((x) => x.personId === p.id)
  if (!t?.gross) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">HSA (pre-tax)</span>
          <NumberField
            ariaLabel={`${p.name} HSA contribution`}
            prefix="$"
            value={p.pretax.hsa}
            onChange={(v) => update({ hsa: Math.max(0, v) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Commuter (pre-tax)</span>
          <NumberField
            ariaLabel={`${p.name} commuter benefit`}
            prefix="$"
            value={p.pretax.commuter}
            onChange={(v) => update({ commuter: Math.max(0, v) })}
          />
        </label>
      </div>
      <span className="text-muted-foreground">
        {year} on {usd(t.gross)}: federal {usd(t.federal)}, FICA {usd(t.fica)},
        state {usd(t.state)}. Take-home{" "}
        <span className="font-mono text-foreground tabular-nums">
          {usd(t.takeHome)}
        </span>{" "}
        ({pct(t.takeHome / t.gross, 1)}), marginal {pct(t.marginalRate, 0)}
        {pay.joint ? ", filing jointly" : ""}.
      </span>
    </div>
  )
}
