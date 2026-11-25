// The render gate: decides whether an agent-written dashboard spec may render
// against a data document. Shared by the CLI (`just dashboard-check`) and the
// browser (which falls back to the last-known-good spec on failure), so it
// uses no Node APIs.
//
// Checks, in order:
// 1. the spec is an object with `root` + `elements`, no `state` key, and a
//    valid `meta` block (catalogVersion an integer <= CATALOG_VERSION);
// 2. json-render's structural `validateSpec` (root, children exist);
// 3. per element: a known component type, only known element fields, children
//    only where the component has a default slot, named slots that exist,
//    and props that pass the component's Zod schema (json-render's own
//    `catalog.validate` skips this once the catalog has 2+ components);
// 4. every `$state` pointer is well formed (no numeric index), resolves in
//    the data, and has the shape its prop expects (arrays for lists, numbers
//    for values, strings for bare refs inside text); list and series items
//    carry the fields their component reads, and a percent format sits on a
//    0..1 fraction;
// 5. the element graph from root has no cycles; unreachable elements warn.
import { type Spec, validateSpec } from "@json-render/core"

import { literalTextIssues, pointerIssues } from "./bound"
import { CATALOG_VERSION, catalog as defaultCatalog } from "./catalog"

export type GateSeverity = "error" | "warning"

export interface GateIssue {
  severity: GateSeverity
  /** Machine-readable kind, e.g. "unknown_component", "unresolved_pointer". */
  code: string
  message: string
  /** Element key the issue belongs to, when there is one. */
  element?: string
  /** Where inside the element (e.g. "props.value", "visible"). */
  path?: string
}

export interface GateResult {
  ok: boolean
  issues: GateIssue[]
}

export interface SpecMeta {
  catalogVersion: number
  issueDate: string
  lens: string
  headline: string | null
  note: string | null
}

/** The subset of a json-render catalog the gate needs. */
export interface GateCatalog {
  data: {
    components: Record<
      string,
      {
        props: {
          safeParse(v: unknown): {
            success: boolean
            error?: {
              issues: { path: PropertyKey[]; message: string }[]
            }
          }
        }
        slots?: readonly string[]
      }
    >
  }
}

/** Element keys double as annotation targets (feedback.jsonl `element`). */
const ELEMENT_KEY = /^[A-Za-z0-9_\-:.]{1,128}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ELEMENT_FIELDS = new Set([
  "type",
  "props",
  "children",
  "slots",
  "visible",
  "repeat",
])

type Shape = "number" | "string" | "array" | "object"

/** Expected shape of each data-backed prop, by component. */
const PROP_SHAPES: Record<string, Record<string, Shape>> = {
  NetWorthHero: {
    value: "number",
    d30: "number",
    ytd: "number",
    series: "array",
  },
  StatTile: { value: "number", delta: "number", spark: "array" },
  PaceChart: {
    mtdCurve: "array",
    usualCurve: "array",
    usualMonth: "number",
    delta: "number",
  },
  EventList: { items: "array" },
  NeedsYou: { items: "array" },
  Findings: { items: "array" },
  Freshness: { freshness: "object", stale: "array" },
  RecentActivity: { items: "array" },
  MarketMoves: { indices: "array", holdings: "array", asOf: "string" },
  NewsList: { items: "array" },
  PlanTimeline: { items: "array" },
  Insights: { items: "array" },
}

/**
 * Data-backed props that may resolve to null as well as their shape (the
 * component renders a null itself), by component.
 */
const NULLABLE_PROPS: Record<string, ReadonlySet<string>> = {
  MarketMoves: new Set(["asOf"]),
}

/** A trailing "?" means the key must be present but may hold null. */
type FieldType = "string" | "number" | "array" | "string?" | "number?"

/**
 * Fields every item of a bound list must carry, by component and prop. A
 * list bound to the wrong source (NeedsYou on /plan/events) passes the array
 * check but renders blank rows, so the items are checked too.
 */
const ITEM_FIELDS: Record<string, Record<string, Record<string, FieldType>>> = {
  NeedsYou: { items: { date: "string", title: "string", kind: "string" } },
  EventList: {
    items: {
      date: "string",
      label: "string",
      amount: "number",
      kind: "string",
    },
  },
  Findings: { items: { id: "string", kind: "string", title: "string" } },
  Freshness: { stale: { account: "string", reason: "string" } },
  RecentActivity: {
    items: {
      date: "string",
      payee: "string",
      amount: "number",
      category: "string",
      account: "string",
    },
  },
  MarketMoves: {
    indices: {
      symbol: "string",
      name: "string",
      price: "number?",
      change: "number?",
      changePct: "number?",
    },
    holdings: {
      symbol: "string",
      name: "string",
      changePct: "number?",
      weight: "number?",
    },
  },
  NewsList: {
    items: {
      id: "string",
      title: "string",
      source: "string",
      url: "string",
      publishedAt: "string?",
      relevance: "string",
      tags: "array",
    },
  },
  PlanTimeline: {
    items: {
      id: "string",
      date: "string?",
      title: "string",
      detail: "string",
      source: "string",
      status: "string",
    },
  },
  Insights: {
    items: {
      id: "string",
      kind: "string",
      title: "string",
      body: "string",
      date: "string?",
      source: "string",
      amount: "number?",
    },
  },
}

/** True when `v` has the field type `t` ("x?" also accepts null). */
function fieldMatches(v: unknown, t: FieldType): boolean {
  const got = shapeOf(v)
  if (t.endsWith("?")) return got === "null" || got === t.slice(0, -1)
  return got === t
}

/** Largest magnitude a value may have and still read as a 0..1 fraction. */
const MAX_FRACTION = 1.5

const FORMAT_SHAPES: Record<string, Shape> = {
  currency: "number",
  number: "number",
  percent: "number",
  date: "string",
}

// ── Helpers ────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function shapeOf(v: unknown): Shape | "null" | "boolean" | "undefined" {
  if (v === undefined) return "undefined"
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "null"
  if (typeof v === "string") return "string"
  if (typeof v === "boolean") return "boolean"
  return "object"
}

/** RFC 6901 lookup. Returns `undefined` when any segment is missing. */
export function resolvePointer(data: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return data
  let cur: unknown = data
  for (const raw of pointer.slice(1).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (isObject(cur)) {
      if (!Object.hasOwn(cur, seg)) return undefined
      cur = cur[seg]
    } else return undefined
  }
  return cur
}

interface Binding {
  pointer: string
  /** Dotted location inside the element, e.g. "props.text.$concat.2.value". */
  path: string
  expect?: Shape
  /** Rendered as a percent, so the value must be a 0..1 fraction. */
  fraction?: boolean
}

/**
 * Every `$state` reference inside `value`, with the shape it should resolve
 * to when that is known from context (a `$format` kind, a bare ref in a
 * `$concat`, or the component prop it sits on).
 */
function collectBindings(
  value: unknown,
  path: string,
  expect: Shape | undefined,
  out: Binding[]
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectBindings(v, `${path}.${i}`, undefined, out)
    })
    return
  }
  if (!isObject(value)) return
  if (typeof value.$state === "string") {
    out.push({ pointer: value.$state, path, expect })
  }
  if (typeof value.$format === "string") {
    const before = out.length
    collectBindings(
      value.value,
      `${path}.value`,
      FORMAT_SHAPES[value.$format],
      out
    )
    if (value.$format === "percent")
      for (const b of out.slice(before)) b.fraction = true
  }
  if (Array.isArray(value.$concat)) {
    value.$concat.forEach((part, i) => {
      const p = `${path}.$concat.${i}`
      // A bare $state inside $concat is stringified raw ("1234.5"), so it
      // must point at a string; amounts go through $format.
      if (isObject(part) && typeof part.$state === "string")
        out.push({ pointer: part.$state, path: p, expect: "string" })
      else collectBindings(part, p, undefined, out)
    })
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "$state" || k === "$concat") continue
    if (k === "value" && typeof value.$format === "string") continue
    collectBindings(v, `${path}.${k}`, undefined, out)
  }
}

/** Removes the top-level `meta` block; json-render never sees it. */
export function stripMeta(spec: unknown): unknown {
  if (!isObject(spec)) return spec
  const { meta: _meta, ...rest } = spec
  return rest
}

/** True for a YYYY-MM-DD string that names a real calendar day. */
export function isRealDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false
  const [y, m, d] = iso.split("-").map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  )
}

/**
 * Problems with the items of a list or series prop, or [] when they are fine.
 * Checks every item against the fields the component reads.
 */
function itemIssues(
  type: string,
  prop: string,
  props: Record<string, unknown>,
  value: unknown[]
): string[] {
  let fields = ITEM_FIELDS[type]?.[prop]
  if (type === "NetWorthHero" && prop === "series") {
    const field = typeof props.field === "string" ? props.field : "netWorth"
    fields = { [field]: "number" }
  }
  if (type === "PaceChart" && (prop === "mtdCurve" || prop === "usualCurve")) {
    const bad = value.findIndex((x) => shapeOf(x) !== "number")
    return bad < 0
      ? []
      : [`item ${bad} is ${shapeOf(value[bad])}, expected a number`]
  }
  if (type === "StatTile" && prop === "spark") {
    const sparkField =
      typeof props.sparkField === "string" ? props.sparkField : undefined
    if (value.every((x) => shapeOf(x) === "number")) return []
    if (!sparkField)
      return [
        "items are objects; set sparkField to a numeric field on each item, or bind an array of numbers",
      ]
    fields = { [sparkField]: "number" }
  }
  if (!fields) return []
  for (const [i, item] of value.entries()) {
    if (!isObject(item))
      return [`item ${i} is ${shapeOf(item)}, expected an object`]
    const missing = Object.entries(fields)
      .filter(([f, t]) => !fieldMatches(item[f], t))
      .map(([f, t]) => `${f} (${t})`)
    if (missing.length > 0)
      return [
        `item ${i} lacks ${missing.join(", ")}; this list is meant for a source whose items carry ${Object.keys(fields).join(", ")}`,
      ]
  }
  return []
}

function checkMeta(meta: unknown, issues: GateIssue[]): void {
  const err = (code: string, message: string) =>
    issues.push({ severity: "error", code, message, path: "meta" })
  if (!isObject(meta)) {
    err("missing_meta", "spec has no meta block")
    return
  }
  const v = meta.catalogVersion
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    err("bad_catalog_version", "meta.catalogVersion must be an integer >= 1")
  else if (v > CATALOG_VERSION)
    err(
      "catalog_too_new",
      `meta.catalogVersion ${v} is newer than the deployed catalog (${CATALOG_VERSION})`
    )
  if (typeof meta.issueDate !== "string" || !ISO_DATE.test(meta.issueDate))
    err("bad_issue_date", "meta.issueDate must be YYYY-MM-DD")
  else if (!isRealDate(meta.issueDate))
    err(
      "bad_issue_date",
      `meta.issueDate ${meta.issueDate} is not a real calendar date`
    )
  if (typeof meta.lens !== "string" || meta.lens.trim() === "")
    err("bad_lens", "meta.lens must be a non-empty string")
  for (const key of ["headline", "note"] as const) {
    const t = meta[key]
    if (t === undefined || t === null) continue
    if (typeof t !== "string") {
      err(`bad_${key}`, `meta.${key} must be a string or null`)
      continue
    }
    for (const m of literalTextIssues(t))
      err("literal_value", `meta.${key} ${m}`)
  }
  const known = new Set([
    "catalogVersion",
    "issueDate",
    "lens",
    "headline",
    "note",
  ])
  for (const k of Object.keys(meta))
    if (!known.has(k))
      issues.push({
        severity: "warning",
        code: "unknown_meta_key",
        message: `meta.${k} is not part of the meta contract`,
        path: "meta",
      })
}

// ── The gate ───────────────────────────────────────────────────────────

/**
 * Checks `spec` (as the agent wrote it, meta included) against `data` (the
 * snapshot + derived document) and the catalog. `ok` is false when any issue
 * has severity "error"; warnings never block.
 */
export function renderGate(
  spec: unknown,
  data: unknown,
  cat: GateCatalog = defaultCatalog as unknown as GateCatalog
): GateResult {
  const issues: GateIssue[] = []
  const error = (i: Omit<GateIssue, "severity">) =>
    issues.push({ severity: "error", ...i })
  const done = (): GateResult => ({
    ok: !issues.some((i) => i.severity === "error"),
    issues,
  })

  if (!isObject(spec)) {
    error({ code: "not_an_object", message: "spec must be a JSON object" })
    return done()
  }
  if (!isObject(data)) {
    error({ code: "no_data", message: "data document is missing" })
    return done()
  }
  if ("state" in spec)
    error({
      code: "state_key",
      message:
        'spec has a "state" key; data comes from the data document, never the spec',
    })
  checkMeta(spec.meta, issues)
  for (const k of Object.keys(spec))
    if (!["root", "elements", "meta", "state"].includes(k))
      error({
        code: "unknown_spec_key",
        message: `unknown top-level key "${k}"`,
      })

  const body = stripMeta(spec) as Record<string, unknown>
  if (typeof body.root !== "string" || !isObject(body.elements)) {
    error({
      code: "bad_structure",
      message: "spec needs a string root and an elements object",
    })
    return done()
  }
  const elements = body.elements as Record<string, unknown>

  // json-render structural checks (root exists, children exist, etc.).
  const structural = validateSpec(body as unknown as Spec, {
    checkOrphans: false,
  })
  for (const i of structural.issues)
    issues.push({
      severity: i.severity,
      code: i.code,
      message: i.message,
      element: i.elementKey,
    })

  const components = cat.data.components
  for (const [key, el] of Object.entries(elements)) {
    if (!ELEMENT_KEY.test(key))
      error({
        code: "bad_element_key",
        element: key,
        message: "element keys must match [A-Za-z0-9_-:.] (1 to 128 chars)",
      })
    if (!isObject(el)) {
      error({ code: "bad_element", element: key, message: "not an object" })
      continue
    }
    for (const f of Object.keys(el))
      if (!ELEMENT_FIELDS.has(f))
        error({
          code: "unknown_element_field",
          element: key,
          path: f,
          message: `"${f}" is not allowed on an element (no actions, watchers or styling in v0)`,
        })

    const type = el.type
    const def = typeof type === "string" ? components[type] : undefined
    if (!def) {
      error({
        code: "unknown_component",
        element: key,
        message: `unknown component type "${String(type)}"; use only catalog components`,
      })
      continue
    }

    // Children and slots.
    const slots = def.slots ?? []
    const children = el.children ?? []
    if (!Array.isArray(children))
      error({
        code: "bad_children",
        element: key,
        message: "children must be an array",
      })
    else if (children.length > 0 && !slots.includes("default"))
      error({
        code: "unexpected_children",
        element: key,
        message: `${type} takes no children`,
      })
    if (el.slots !== undefined) {
      if (!isObject(el.slots))
        error({
          code: "bad_slots",
          element: key,
          message: "slots must be an object",
        })
      else
        for (const [slot, keys] of Object.entries(el.slots)) {
          if (slot === "default" || !slots.includes(slot))
            error({
              code: "unknown_slot",
              element: key,
              path: `slots.${slot}`,
              message:
                slot === "default"
                  ? 'use "children" for the default slot'
                  : `${type} has no slot "${slot}"`,
            })
          if (!Array.isArray(keys) || keys.some((k) => !(k in elements)))
            error({
              code: "missing_child",
              element: key,
              path: `slots.${slot}`,
              message: `slot "${slot}" references a missing element`,
            })
        }
    }

    // Props against the component schema.
    const props = el.props ?? {}
    const parsed = def.props.safeParse(props)
    if (!parsed.success)
      for (const i of parsed.error?.issues ?? [])
        error({
          code: "invalid_props",
          element: key,
          path: ["props", ...i.path.map(String)].join("."),
          message: i.message,
        })

    // Bindings: well formed, resolvable, right shape.
    const bindings: Binding[] = []
    const propOf = new Map<Binding, string>()
    if (isObject(props))
      for (const [prop, v] of Object.entries(props)) {
        const before = bindings.length
        collectBindings(
          v,
          `props.${prop}`,
          PROP_SHAPES[type as string]?.[prop],
          bindings
        )
        for (const b of bindings.slice(before)) {
          if (b.path === `props.${prop}`) propOf.set(b, prop)
          if (
            type === "StatTile" &&
            props.format === "percent" &&
            (prop === "value" || prop === "delta") &&
            b.path === `props.${prop}`
          )
            b.fraction = true
        }
      }
    collectBindings(el.visible, "visible", undefined, bindings)
    if (isObject(el.repeat) && typeof el.repeat.statePath === "string")
      bindings.push({
        pointer: el.repeat.statePath,
        path: "repeat.statePath",
        expect: "array",
      })
    for (const b of bindings) {
      const bad = pointerIssues(b.pointer)
      if (bad.length > 0) {
        for (const m of bad)
          error({
            code: "bad_pointer",
            element: key,
            path: b.path,
            message: `pointer ${b.pointer} ${m}`,
          })
        continue
      }
      const v = resolvePointer(data, b.pointer)
      if (v === undefined) {
        error({
          code: "unresolved_pointer",
          element: key,
          path: b.path,
          message: `pointer ${b.pointer} does not resolve in the data`,
        })
        continue
      }
      const got = shapeOf(v)
      const prop = propOf.get(b)
      const nullOk =
        got === "null" &&
        prop !== undefined &&
        (NULLABLE_PROPS[type as string]?.has(prop) ?? false)
      if (b.expect && got !== b.expect && !nullOk) {
        error({
          code: "wrong_shape",
          element: key,
          path: b.path,
          message: `pointer ${b.pointer} is ${got}, expected ${b.expect}`,
        })
        continue
      }
      if (prop && Array.isArray(v) && isObject(props))
        for (const m of itemIssues(type as string, prop, props, v))
          error({
            code: "wrong_item_shape",
            element: key,
            path: b.path,
            message: `pointer ${b.pointer}: ${m}`,
          })
      if (
        b.fraction &&
        got === "number" &&
        Math.abs(v as number) > MAX_FRACTION
      )
        error({
          code: "not_a_fraction",
          element: key,
          path: b.path,
          message: `pointer ${b.pointer} is ${String(v)}, not a 0..1 fraction; percent format would show it as ${Math.round((v as number) * 100)}%. Use money or number`,
        })
    }
  }

  // Graph: no cycles from root; orphans are a warning.
  const seen = new Set<string>()
  const onPath = new Set<string>()
  const childKeys = (k: string): string[] => {
    const el = elements[k]
    if (!isObject(el)) return []
    const out = Array.isArray(el.children) ? [...el.children] : []
    if (isObject(el.slots))
      for (const v of Object.values(el.slots))
        if (Array.isArray(v)) out.push(...v)
    return out.filter((c): c is string => typeof c === "string")
  }
  const visit = (k: string): void => {
    if (onPath.has(k)) {
      error({
        code: "cycle",
        element: k,
        message: "element is its own ancestor",
      })
      return
    }
    if (seen.has(k) || !(k in elements)) return
    seen.add(k)
    onPath.add(k)
    for (const c of childKeys(k)) visit(c)
    onPath.delete(k)
  }
  visit(body.root)
  for (const k of Object.keys(elements))
    if (!seen.has(k))
      issues.push({
        severity: "warning",
        code: "orphaned_element",
        element: k,
        message: "element is not reachable from root",
      })

  // One lead per issue: two leads is no lead.
  const leads = Object.entries(elements).filter(
    ([, el]) =>
      isObject(el) &&
      el.type === "Panel" &&
      isObject(el.props) &&
      el.props.lead === true
  )
  if (leads.length > 1)
    error({
      code: "many_leads",
      element: leads[1][0],
      message: `${leads.length} Panels have lead: true; mark at most one`,
    })

  return done()
}

// ── Summary ────────────────────────────────────────────────────────────

export interface SpecSummary {
  meta: Partial<SpecMeta> | null
  elementCount: number
  /** First content element in reading order (not layout, not Freshness). */
  lead: { key: string; type: string } | null
  /** First NetWorthHero, PaceChart or StatTile in reading order. */
  hero: { key: string; type: string } | null
  /** Element types in depth-first reading order from root. */
  order: string[]
  /**
   * One label per direct child of root, in order: the type for content, and
   * `Layout[FirstContent]` for a layout child (e.g. "Panel[NeedsYou]").
   */
  topOrder: string[]
}

const LAYOUT = new Set(["Stack", "Grid", "Panel"])
/** Never the lead: layout, and the small as-of line. */
const NOT_LEAD = new Set([...LAYOUT, "Freshness"])
const HERO = new Set(["NetWorthHero", "PaceChart", "StatTile"])

/** A short structural description of a spec, for the CLI and the prompt. */
export function summarizeSpec(spec: unknown): SpecSummary {
  const empty: SpecSummary = {
    meta: null,
    elementCount: 0,
    lead: null,
    hero: null,
    order: [],
    topOrder: [],
  }
  if (!isObject(spec)) return empty
  const meta = isObject(spec.meta) ? (spec.meta as Partial<SpecMeta>) : null
  const elements = isObject(spec.elements) ? spec.elements : {}
  const order: string[] = []
  let lead: SpecSummary["lead"] = null
  let hero: SpecSummary["hero"] = null
  const seen = new Set<string>()
  const kidsOf = (el: Record<string, unknown>): string[] => {
    const out = Array.isArray(el.children) ? [...el.children] : []
    if (isObject(el.slots))
      for (const v of Object.values(el.slots))
        if (Array.isArray(v)) out.push(...v)
    return out.filter((c): c is string => typeof c === "string")
  }
  const walk = (k: string) => {
    if (seen.has(k)) return
    seen.add(k)
    const el = elements[k]
    if (!isObject(el)) return
    const type = String(el.type)
    order.push(type)
    if (!lead && !NOT_LEAD.has(type)) lead = { key: k, type }
    if (!hero && HERO.has(type)) hero = { key: k, type }
    for (const c of kidsOf(el)) walk(c)
  }
  /** First content type under `k` (depth first), for topOrder labels. */
  const firstContent = (k: string, path: Set<string>): string | null => {
    if (path.has(k)) return null
    const el = elements[k]
    if (!isObject(el)) return null
    const type = String(el.type)
    if (!LAYOUT.has(type)) return type
    path.add(k)
    for (const c of kidsOf(el)) {
      const t = firstContent(c, path)
      if (t) return t
    }
    return null
  }
  const topOrder: string[] = []
  if (typeof spec.root === "string") {
    walk(spec.root)
    const root = elements[spec.root]
    if (isObject(root))
      for (const c of kidsOf(root)) {
        const el = elements[c]
        if (!isObject(el)) continue
        const type = String(el.type)
        if (!LAYOUT.has(type)) topOrder.push(type)
        else {
          const inner = firstContent(c, new Set([spec.root]))
          topOrder.push(inner ? `${type}[${inner}]` : type)
        }
      }
  }
  return {
    meta,
    elementCount: Object.keys(elements).length,
    lead,
    hero,
    order,
    topOrder,
  }
}

/** One line per issue, for terminals and logs. */
export function formatIssues(issues: GateIssue[]): string {
  return issues
    .map((i) => {
      const where = [i.element, i.path].filter(Boolean).join(" ")
      return `${i.severity === "error" ? "ERROR" : "warn "} ${i.code}${where ? ` [${where}]` : ""}: ${i.message}`
    })
    .join("\n")
}
