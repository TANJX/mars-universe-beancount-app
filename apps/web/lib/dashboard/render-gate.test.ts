import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { literalTextIssues } from "./bound"
import { CATALOG_VERSION } from "./catalog"
import {
  type GateResult,
  isRealDate,
  renderGate,
  summarizeSpec,
} from "./render-gate"

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"))

const fixture = read("./fixtures/snapshot.demo.json")
const defaultSpec = read("./default-spec.json")

// biome-ignore lint/suspicious/noExplicitAny: specs are untyped JSON in tests
type AnySpec = any
const clone = (): AnySpec => structuredClone(defaultSpec)

const codes = (r: GateResult) =>
  r.issues.filter((i) => i.severity === "error").map((i) => i.code)

function assertFails(r: GateResult, code: string, element?: string) {
  assert.equal(r.ok, false, "expected the gate to fail")
  const hit = r.issues.find(
    (i) =>
      i.severity === "error" &&
      i.code === code &&
      (element === undefined || i.element === element)
  )
  assert.ok(hit, `expected a ${code} error; got ${codes(r).join(", ")}`)
}

test("default spec passes against the synthetic fixture", () => {
  const r = renderGate(defaultSpec, fixture)
  assert.deepEqual(r.issues, [])
  assert.equal(r.ok, true)
})

test("default spec stays within the hygiene element range", () => {
  const s = summarizeSpec(defaultSpec)
  assert.ok(s.elementCount >= 10 && s.elementCount <= 25)
  assert.equal(s.lead?.type, "NetWorthHero")
  assert.equal(s.meta?.catalogVersion, CATALOG_VERSION)
})

test("a literal number in a Bound prop fails", () => {
  const spec = clone()
  spec.elements.hero.props.value = 123456
  assertFails(renderGate(spec, fixture), "invalid_props", "hero")
})

test("a literal number inside $format fails", () => {
  const spec = clone()
  spec.elements.brief.props.text.$concat[1].value = 42
  assertFails(renderGate(spec, fixture), "invalid_props", "brief")
})

test("a currency amount in literal text fails", () => {
  const spec = clone()
  spec.elements["low-tile"].props.caption = "About $5,000 spare"
  assertFails(renderGate(spec, fixture), "invalid_props", "low-tile")
})

test("an unknown component fails", () => {
  const spec = clone()
  spec.elements.hero.type = "Sparkle"
  assertFails(renderGate(spec, fixture), "unknown_component", "hero")
})

test("a numeric pointer index fails", () => {
  const spec = clone()
  spec.elements["low-tile"].props.value = {
    $state: "/derived/cardsDue/0/statement",
  }
  const r = renderGate(spec, fixture)
  assertFails(r, "invalid_props", "low-tile")
  assertFails(r, "bad_pointer", "low-tile")
})

test("an unresolvable pointer fails", () => {
  const spec = clone()
  spec.elements.hero.props.value = { $state: "/netWorth/nope" }
  assertFails(renderGate(spec, fixture), "unresolved_pointer", "hero")
})

test("a pointer with the wrong shape fails", () => {
  const spec = clone()
  spec.elements.events.props.items = { $state: "/plan/startCash" }
  assertFails(renderGate(spec, fixture), "wrong_shape", "events")
})

test("a bare $state number inside $concat fails", () => {
  const spec = clone()
  spec.elements.brief.props.text.$concat[1] = { $state: "/derived/paceDelta" }
  assertFails(renderGate(spec, fixture), "wrong_shape", "brief")
})

test('a "state" key fails', () => {
  const spec = clone()
  spec.state = { netWorth: { value: 1 } }
  assertFails(renderGate(spec, fixture), "state_key")
})

test("a catalogVersion newer than the catalog fails", () => {
  const spec = clone()
  spec.meta.catalogVersion = CATALOG_VERSION + 1
  assertFails(renderGate(spec, fixture), "catalog_too_new")
  spec.meta.catalogVersion = 1.5
  assertFails(renderGate(spec, fixture), "bad_catalog_version")
})

test("missing meta fails", () => {
  const spec = clone()
  delete spec.meta
  assertFails(renderGate(spec, fixture), "missing_meta")
})

test("children on a leaf component fail", () => {
  const spec = clone()
  spec.elements.hero.children = ["brief"]
  assertFails(renderGate(spec, fixture), "unexpected_children", "hero")
})

test("a missing child fails", () => {
  const spec = clone()
  spec.elements.page.children.push("ghost")
  assert.equal(renderGate(spec, fixture).ok, false)
})

test("a named slot passes; an unknown slot fails", () => {
  const spec = clone()
  spec.elements.page.children = spec.elements.page.children.filter(
    (k: string) => k !== "freshness"
  )
  spec.elements["needs-panel"].slots = { action: ["freshness"] }
  assert.deepEqual(renderGate(spec, fixture).issues, [])
  spec.elements["needs-panel"].slots = { footer: ["freshness"] }
  assertFails(renderGate(spec, fixture), "unknown_slot", "needs-panel")
})

test("a className prop fails", () => {
  const spec = clone()
  spec.elements.page.props.className = "bg-red-500"
  assertFails(renderGate(spec, fixture), "invalid_props", "page")
})

test("event bindings are not allowed", () => {
  const spec = clone()
  spec.elements.hero.on = { press: { action: "setState" } }
  assertFails(renderGate(spec, fixture), "unknown_element_field", "hero")
})

test("a cycle fails", () => {
  const spec = clone()
  spec.elements["main-left"].children.push("main")
  assertFails(renderGate(spec, fixture), "cycle")
})

test("an orphaned element warns but passes", () => {
  const spec = clone()
  spec.elements.extra = {
    type: "Note",
    props: { tone: "info", text: "Spare" },
    children: [],
  }
  const r = renderGate(spec, fixture)
  assert.equal(r.ok, true)
  assert.ok(r.issues.some((i) => i.code === "orphaned_element"))
})

test("no data fails", () => {
  assertFails(renderGate(defaultSpec, null), "no_data")
})

// ── Literal text (finding: disguised numbers) ──────────────────────────

test("scaled, percent and worded amounts in literal text are rejected", () => {
  for (const t of [
    "About 1.2k left",
    "12k saved",
    "Up 85%",
    "Down 5 %",
    "3m in the bank",
    "A 2bn market",
    "40 dollars spare",
    "1 dollar",
    "40 percent of usual",
    "2000 under usual",
    "1950 spent",
  ])
    assert.ok(
      literalTextIssues(t).length > 0,
      `expected a rejection for "${t}"`
    )
})

test("plain words and small counts in literal text pass", () => {
  for (const t of [
    "Next 2 months",
    "30d",
    "Trailing three months",
    "Saving rate",
    "Q1 review",
  ])
    assert.deepEqual(literalTextIssues(t), [], `expected "${t}" to pass`)
})

test("a year passes only in a Panel title or eyebrow", () => {
  assert.deepEqual(
    literalTextIssues("2026 contributions", { allowYears: true }),
    []
  )
  assert.ok(literalTextIssues("2026 contributions").length > 0)
  const spec = clone()
  spec.elements["pace-panel"].props.title = "2026 pace"
  spec.elements["pace-panel"].props.eyebrow = "Since 2025"
  assert.equal(renderGate(spec, fixture).ok, true)
  spec.elements["low-tile"].props.caption = "Lowest since 2025"
  assertFails(renderGate(spec, fixture), "invalid_props", "low-tile")
})

test("a disguised number in meta.headline fails", () => {
  const spec = clone()
  spec.meta.headline = "Spending 1.2k under usual"
  assertFails(renderGate(spec, fixture), "literal_value")
})

test("a disguised number inside $concat words fails", () => {
  const spec = clone()
  spec.elements.brief.props.text.$concat[0] = "About 85% of usual: "
  assertFails(renderGate(spec, fixture), "invalid_props", "brief")
})

// ── Item shapes (finding: right type, wrong items) ─────────────────────

test("NeedsYou bound to plan events fails the item check", () => {
  const spec = clone()
  spec.elements.needs.props.items = { $state: "/plan/events" }
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "needs")
})

test("EventList bound to needsYou fails the item check", () => {
  const spec = clone()
  spec.elements.events.props.items = { $state: "/derived/needsYou" }
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "events")
})

test("a spark of objects without sparkField fails", () => {
  const spec = clone()
  delete spec.elements["income-tile"].props.sparkField
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "income-tile")
  spec.elements["income-tile"].props.sparkField = "nope"
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "income-tile")
})

test("a NetWorthHero field missing from the series fails", () => {
  const spec = clone()
  spec.elements.hero.props.series = { $state: "/spend/byMonth" }
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "hero")
})

test("percent format on a dollar amount fails", () => {
  const spec = clone()
  spec.elements["spent-tile"].props.format = "percent"
  assertFails(renderGate(spec, fixture), "not_a_fraction", "spent-tile")
  const spec2 = clone()
  spec2.elements.brief.props.text.$concat[1] = {
    $format: "percent",
    value: { $state: "/spend/mtd" },
  }
  assertFails(renderGate(spec2, fixture), "not_a_fraction", "brief")
})

test("percent format on a fraction passes", () => {
  const spec = clone()
  spec.elements.brief.props.text.$concat[1] = {
    $format: "percent",
    value: { $state: "/savingsRate3m" },
  }
  assert.equal(renderGate(spec, fixture).ok, true)
})

// ── Findings ───────────────────────────────────────────────────────────

test("Findings bound to /derived/findings passes; to needsYou fails", () => {
  const spec = clone()
  spec.elements.findings = {
    type: "Findings",
    props: { items: { $state: "/derived/findings" }, limit: 4 },
    children: [],
  }
  spec.elements.page.children.splice(2, 0, "findings")
  assert.deepEqual(renderGate(spec, fixture).issues, [])
  spec.elements.findings.props.items = { $state: "/derived/needsYou" }
  assertFails(renderGate(spec, fixture), "wrong_item_shape", "findings")
})

// ── Dates ──────────────────────────────────────────────────────────────

test("an impossible issue date fails", () => {
  assert.equal(isRealDate("2026-02-31"), false)
  assert.equal(isRealDate("2028-02-29"), true)
  const spec = clone()
  spec.meta.issueDate = "2026-02-31"
  assertFails(renderGate(spec, fixture), "bad_issue_date")
  spec.meta.issueDate = "2026-13-01"
  assertFails(renderGate(spec, fixture), "bad_issue_date")
})

// ── Summary (anti-sameness inputs) ─────────────────────────────────────

test("summary: lead skips layout and Freshness; hero and top-level order", () => {
  const spec = clone()
  spec.elements.page.children = ["freshness", "main", "kpis", "hero"]
  const s = summarizeSpec(spec)
  assert.equal(s.lead?.type, "PaceChart")
  assert.equal(s.lead?.key, "pace")
  assert.equal(s.hero?.key, "pace")
  assert.deepEqual(s.topOrder, [
    "Freshness",
    "Grid[PaceChart]",
    "Grid[StatTile]",
    "NetWorthHero",
  ])
})

// ── v3: recent activity and the daily context ──────────────────────────

/** The default spec with `el` added to the page under `key`. */
function withElement(key: string, el: AnySpec): AnySpec {
  const spec = clone()
  spec.elements[key] = { children: [], ...el }
  spec.elements.page.children.splice(1, 0, key)
  return spec
}

const V3_ELEMENTS: Record<string, AnySpec> = {
  recent: {
    type: "RecentActivity",
    props: { items: { $state: "/recent" }, limit: 6, withinDays: 7 },
  },
  market: {
    type: "MarketMoves",
    props: {
      indices: { $state: "/derived/context/market/indices" },
      holdings: { $state: "/derived/context/market/holdings" },
      asOf: { $state: "/derived/context/market/asOf" },
      limit: 5,
    },
  },
  news: {
    type: "NewsList",
    props: { items: { $state: "/derived/context/news" }, limit: 3 },
  },
  plan: {
    type: "PlanTimeline",
    props: {
      items: { $state: "/derived/context/plan" },
      limit: 10,
      withinDays: 60,
      emptyText: "Nothing planned",
    },
  },
  insights: {
    type: "Insights",
    props: {
      items: { $state: "/derived/context/insights" },
      limit: 4,
      kinds: ["plan", "risk"],
      layout: "cards",
    },
  },
}

test("catalog v3+ components pass bound to their sources", () => {
  assert.equal(CATALOG_VERSION, 4)
  for (const [key, el] of Object.entries(V3_ELEMENTS)) {
    const r = renderGate(withElement(key, el), fixture)
    assert.deepEqual(r.issues, [], `${key}: ${JSON.stringify(r.issues)}`)
  }
})

test("v3 lists bound to the wrong source fail the item check", () => {
  const wrong: [string, string, string][] = [
    ["recent", "items", "/derived/needsYou"],
    ["news", "items", "/derived/context/plan"],
    ["plan", "items", "/derived/context/insights"],
    ["insights", "items", "/derived/context/news"],
    ["market", "holdings", "/derived/context/market/indices"],
    ["market", "indices", "/recent"],
  ]
  for (const [key, prop, pointer] of wrong) {
    const el = structuredClone(V3_ELEMENTS[key])
    el.props[prop] = { $state: pointer }
    assertFails(
      renderGate(withElement(key, el), fixture),
      "wrong_item_shape",
      key
    )
  }
})

test("an item missing a nullable key fails; a null value passes", () => {
  const data = structuredClone(fixture)
  data.derived.context.plan[0].date = null
  const spec = withElement("plan", V3_ELEMENTS.plan)
  assert.equal(renderGate(spec, data).ok, true)
  delete data.derived.context.plan[0].date
  assertFails(renderGate(spec, data), "wrong_item_shape", "plan")
})

test("MarketMoves asOf may be null but not a number", () => {
  const spec = withElement("market", V3_ELEMENTS.market)
  const data = structuredClone(fixture)
  data.derived.context.market.asOf = null
  assert.equal(renderGate(spec, data).ok, true)
  data.derived.context.market.asOf = 5
  assertFails(renderGate(spec, data), "wrong_shape", "market")
})

test("empty context lists pass", () => {
  const data = structuredClone(fixture)
  data.derived.context = {
    generatedAt: null,
    market: { asOf: null, indices: [], holdings: [], note: null },
    news: [],
    plan: [],
    insights: [],
  }
  for (const [key, el] of Object.entries(V3_ELEMENTS)) {
    if (key === "recent") continue
    assert.equal(renderGate(withElement(key, el), data).ok, true, key)
  }
})

test("v3 config props are literal and bounded", () => {
  const cases: [string, string, unknown][] = [
    ["news", "limit", 9],
    ["recent", "withinDays", 31],
    ["plan", "withinDays", 121],
    ["insights", "kinds", ["gossip"]],
    ["insights", "layout", "grid"],
    ["market", "limit", { $state: "/derived/context/market/indices" }],
    ["plan", "emptyText", "Nothing over $500"],
  ]
  for (const [key, prop, value] of cases) {
    const el = structuredClone(V3_ELEMENTS[key])
    el.props[prop] = value
    assertFails(renderGate(withElement(key, el), fixture), "invalid_props", key)
  }
})

test("a literal in a v3 Bound prop fails", () => {
  const el = structuredClone(V3_ELEMENTS.news)
  el.props.items = [{ id: "x", title: "Typed in" }]
  assertFails(renderGate(withElement("news", el), fixture), "invalid_props")
})
