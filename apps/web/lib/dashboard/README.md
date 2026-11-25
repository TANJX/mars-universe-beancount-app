# Dashboard catalog

The Home dashboard is written by an agent as a JSON spec and rendered with
[json-render](https://json-render.dev) (`@json-render/core`, `@json-render/react`
and `@json-render/directives`, all pinned to exactly `0.23.2`; the library has
had breaking changes, so bump all three together and on purpose).

Two rules hold everything else up:

1. **Every number is bound to data. The agent never writes a value.**
2. **There is always a last-known-good spec**, so a bad issue renders the previous one.

## Files

| File | What it holds |
| --- | --- |
| `catalog.ts` | `CATALOG_VERSION`, `catalog` (from `defineCatalog`), component props and descriptions, the `$format` directive, data shape types |
| `bound.ts` | `bound<T>()`, pointer rules, the literal-text guard, `richText()`, `Resolve<P>` |
| `render-gate.ts` | `renderGate` (the check the CLI and the browser share), `summarizeSpec` (lead, hero, top-level order) |
| `default-spec.json` | The bundled fallback issue, rendered when no spec or last-known-good spec passes |
| `fixtures/snapshot.demo.json` | Synthetic data document the tests gate the default spec against |

## The spec

A spec is a json-render flat tree plus a `meta` block:

```json
{
  "meta": { "catalogVersion": 3, "issueDate": "2026-01-15", "lens": "morning", "headline": null, "note": null },
  "root": "page",
  "elements": {
    "page": { "type": "Stack", "props": { "gap": "lg" }, "children": ["brief", "kpis"] },
    "brief": {
      "type": "Note",
      "props": {
        "tone": "info",
        "text": { "$concat": [
          "Day-to-day spending is ",
          { "$format": "currency", "value": { "$state": "/derived/paceDelta" }, "abs": true },
          " away from usual."
        ] }
      },
      "children": []
    },
    "kpis": { "type": "Grid", "props": { "columns": 2 }, "children": ["low"] },
    "low": {
      "type": "StatTile",
      "props": { "label": "Projected low", "value": { "$state": "/plan/low/balance" } },
      "children": []
    }
  }
}
```

- `meta` is stripped before json-render validates or renders the spec.
- A spec never contains a `state` key. The data document is passed in at render
  time as json-render's initial state.
- `meta.issueDate` must be a real calendar date, and `just dashboard-check`
  archives a spec only when it equals today's local date.
- Elements use only the catalog's 16 components; unknown types fail the check.

## Data binding

The data document is the mobile snapshot (schema 2) plus a `derived` block
(`paceDelta`, `needsYou`, `cardsDue`, `cashProjection`, `stale`, `freshness`,
`findings`). `findings` holds the daily reconcile run's results
(`{id, kind, title, amount, from, to, account, date}`, kind one of drift,
settled, opened, statement, skip, note), so a reconcile amount is bound
through the Findings component instead of typed.

`derived.context` holds the daily agent's `context.json`: market moves
(`market.asOf`, `market.indices`, `market.holdings`, `market.note`), `news`,
`plan` (near-term plan steps) and `insights`, summarized from the ledger's
planning docs. Every key is always present; lists are empty and scalars null
when the file or a section is missing or invalid. Plan and insight records
carry a `source` (the doc they came from). `changePct` and `weight` are 0..1
fractions. `/recent` (snapshot) holds the latest transactions, amount
positive for money spent.

- Data-backed props take `{ "$state": "/json/pointer" }` and nothing else
  (`bound<T>()` in `bound.ts`). A literal number, `$cond` or `$computed` fails
  the props schema.
- Pointers start with `/` and contain no numeric array index:
  `/derived/cardsDue/0/due` breaks on a day with no cards due. Bind the whole
  array to a list component instead.
- Config props (`limit`, `columns`, `gap`, `tone`, `title`, `label`) are plain
  literals. There are no `className`, color or style props: props objects are
  strict, and `tone` is an enum the registry maps to `globals.css` tokens.
- Literal text (titles, labels, captions, Note words, `meta.headline` and
  `meta.note`) may not contain currency amounts ("$5", "40 USD", "40 dollars"),
  scaled or percent figures ("1.2k", "3m", "85%", "40 percent") or numbers of
  three or more digits. A bare four-digit year (1900 to 2099) is allowed only
  in a Panel `title` or `subtitle` (or the deprecated `eyebrow`). See `literalTextIssues`.
- The gate also checks the items behind a list or series binding: NeedsYou
  items need `date`, `title`, `kind`; EventList items `date`, `label`,
  `amount`, `kind`; Findings items `id`, `kind`, `title`; RecentActivity
  items `date`, `payee`, `amount`, `category`, `account`; MarketMoves
  indices `symbol`, `name`, `price`, `change`, `changePct` and holdings
  `symbol`, `name`, `changePct`, `weight` (the numbers may be null but the
  keys must be there); NewsList items `id`, `title`, `source`, `url`,
  `publishedAt`, `relevance`, `tags`; PlanTimeline items `id`, `date`,
  `title`, `detail`, `source`, `status`; Insights items `id`, `kind`,
  `title`, `body`, `date`, `source`, `amount`. MarketMoves `asOf` may resolve
  to null. A StatTile `spark`
  of objects needs `sparkField` naming a numeric field; a NetWorthHero
  `series` needs its `field`. A percent format (StatTile `format: "percent"`
  or `$format: "percent"`) needs a 0..1 fraction (magnitude at most 1.5).
- The catalog schemas describe the **raw** spec. The renderer resolves
  bindings before a component runs; registry components should type their
  props with `ResolvedProps<"StatTile">` (bindings replaced by the data type,
  text expressions by `string`).

## Amounts in text

`Note.text` is a `richText()` value: a plain string, a `$format`, or a
`$concat` of literal strings, `$state` bindings (strings only) and `$format`s.

`$format` is the app's own directive (`formatDirective` in `catalog.ts`), with
the same shape as `@json-render/directives` `$format` but stricter:

- `value` must be a `$state` binding (the package version accepts a literal).
- `currency` goes through `formatMoney`, so negatives use U+2212 like `Money`.
  Options: `digits` (0 default, or 2), `signed` (+ on positives), `abs` (drop
  the sign, for "X under/over usual" phrasing).
- `number` rounds to whole numbers; `percent` reads a 0..1 fraction; `date`
  reads an ISO date as a local calendar date ("Dec 7", year added when it
  differs from this year). The package version parses ISO dates as UTC and
  can show the previous day.

`$concat` comes from `@json-render/directives` unchanged. Pass `directives`
from `catalog.ts` to both the renderer (`JSONUIProvider directives={...}`) and
any prompt (`catalog.prompt({ directives })`).

## Prompting

`catalog.prompt()` renders each component's props and description, but its
default text also tells the model to stream JSONL patches, seed `/state`, use
`repeat` and invent sample data. All of that is wrong here. Use the component
list from it (or `catalog.jsonSchema()`, which also carries the `.describe()`
pointer hints such as `/netWorth/value`) inside our own instructions, which say:
edit the whole `spec.json`, bind every number, never write `state`.

## The daily loop

`just dashboard-prompt` prints the instructions, the catalog, the data path
index (`[nullable]` marks values that can be null or absent on another day),
the last 3 issues, 30 days of the ledger's `changelog.jsonl` with the active
pins and rejections, new feedback, and the context sources (the ledger's
planning docs with modification times, to summarize into `context.json`; its
contract and rules; the current `/derived/context`). `just dashboard-check` gates the spec,
prints its lead (first content element, not layout and not Freshness), hero
(first NetWorthHero, PaceChart or StatTile) and top-level order, and warns
without blocking when the lead or the top-level order repeats one of the last
3 archived issues.

`changelog.jsonl` lines, one JSON object each:

- issue line (only for an issue that passed):
  `{"date", "lens", "lead": {"key", "type"}, "order": [top-level labels], "summary", "why"}`
- decision line: `{"date", "decision": "pin" | "reject", "element" | "role", "why"}`.
  The latest decision per element or role wins; a rejection expires after 30 days.

## Validation gotchas (json-render 0.23.2)

- `validateSpec` checks structure only.
- `catalog.validate` stops checking per-component props once a catalog has more
  than one component. Loop over elements and call
  `catalog.data.components[type].props.safeParse(props)` yourself.
- Unknown types, throwing components and unknown actions fail silently at
  render time. The render gate and the last-known-good spec cover this.

## Adding or changing a component

1. Add it to `components` in `catalog.ts`: a `z.strictObject` props schema
   (`bound<T>()` for data, literals for config, `literalText(n)` for text),
   `slots` (`["default"]` for children, `[]` for leaves) and a description
   written for the composing agent: what it shows and what it handles. No
   placement, lead or "use it when" advice: this file is public and fixed,
   and advice here hardens into the same layout every day. Placement belongs
   to the ledger's private standards doc. If a list prop needs particular
   item fields, add them to `ITEM_FIELDS` in `render-gate.ts`.
2. Add its React implementation to the registry.
3. **Bump `CATALOG_VERSION`.** Also bump it for a removed component or any prop
   that changes shape. Specs carry `meta.catalogVersion`, and the daily agent
   is prompted from the deployed version only.
4. Make sure the default spec and the synthetic fixture still pass the check.

## Privacy

This repo is public. Fixtures, examples, default specs and descriptions use
synthetic data invented from scratch ("Checking A", "Card B", round numbers).
Never copy balances, account, card, employer, landlord or merchant names, or
anything from a real ledger or a local snapshot, into this folder.
