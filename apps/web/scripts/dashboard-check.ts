// `just dashboard-check`: runs the render gate on the agent-written spec
// against live data. On a pass it promotes the spec to the last-known-good
// copy and archives it as that day's issue; on a failure it exits 1 and
// leaves both alone.
//
//   node --import ./apps/web/lib/runway/test/resolve-ts.mjs apps/web/scripts/dashboard-check.ts
//     [--spec PATH] [--data PATH] [--no-write]
//
// --spec checks another spec file instead of $LEDGER_DIR/config/dashboard/spec.json
// and never writes,
// --data uses a data document from disk instead of Fava / mobile-snapshot,
// --no-write skips promoting and archiving.
//
// Writing also requires meta.issueDate to be today's local date, so a stale
// spec.json left from an earlier day never overwrites that day's archive.
// After the gate it prints the lead, hero and top-level order, and warns
// (never blocks) when today repeats the lead or the order of one of the last
// 3 archived issues.
//
// Also exports the helpers `dashboard-prompt.ts` shares (live data, paths).
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  formatIssues,
  renderGate,
  type SpecSummary,
  summarizeSpec,
} from "../lib/dashboard/render-gate"

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
export const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url))

// ── Paths ──────────────────────────────────────────────────────────────

export function ledgerDir(): string {
  const dir = process.env.LEDGER_DIR
  if (!dir) {
    console.error(
      "LEDGER_DIR is not set. Run through `just` (which loads .env) or export it."
    )
    process.exit(2)
  }
  return dir
}

export function dashboardDir(): string {
  return join(ledgerDir(), "config", "dashboard")
}

/** Today's date on this machine, YYYY-MM-DD. */
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Archived issue dates in issues/, newest first. */
export function archivedIssueDates(dir: string): string[] {
  const issuesDir = join(dir, "issues")
  if (!existsSync(issuesDir)) return []
  return readdirSync(issuesDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse()
}

/** Summary of an archived issue, or null when it cannot be read. */
export function readIssueSummary(
  dir: string,
  date: string
): SpecSummary | null {
  try {
    return summarizeSpec(
      JSON.parse(readFileSync(join(dir, "issues", `${date}.json`), "utf8"))
    )
  } catch {
    return null
  }
}

/** "Type (key)" or "none". */
export function describeElement(
  e: { key: string; type: string } | null
): string {
  return e ? `${e.type} (${e.key})` : "none"
}

// ── Env (same defaults as next.config.mjs) ─────────────────────────────

function readDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    )
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2")
  }
  return out
}

function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  for (const f of [".env.local", ".env"]) {
    const v = readDotenv(join(WEB_ROOT, f))[name]
    if (v) return v
  }
  return undefined
}

export function favaBase(): string {
  const url = envValue("FAVA_INTERNAL_URL") ?? "http://127.0.0.1:5000"
  const slug = envValue("FAVA_LEDGER_SLUG") ?? "acme-demo"
  return `${url.replace(/\/$/, "")}/${slug}/extension/LedgerDataApi`
}

// ── Live data ──────────────────────────────────────────────────────────

export interface LiveData {
  /** The snapshot + derived document. */
  data: Record<string, unknown>
  source: "fava" | "mobile-snapshot" | "file"
  /** Where it came from (URL or command), for the printout. */
  from: string
}

async function fromFava(): Promise<LiveData | null> {
  const url = `${favaBase()}/dashboard`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: unknown }
    if (typeof body.data !== "object" || body.data === null) return null
    return {
      data: body.data as Record<string, unknown>,
      source: "fava",
      from: url,
    }
  } catch {
    return null
  }
}

function fromCli(): LiveData {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-data-"))
  const out = join(dir, "snapshot.json")
  try {
    const r = spawnSync("uv", ["run", "mobile-snapshot", "--out", out], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    })
    if (r.status !== 0 || !existsSync(out)) {
      console.error(r.stderr || r.stdout || "mobile-snapshot failed")
      throw new Error(
        "could not build the data document (Fava unreachable and mobile-snapshot failed)"
      )
    }
    return {
      data: JSON.parse(readFileSync(out, "utf8")),
      source: "mobile-snapshot",
      from: "uv run mobile-snapshot",
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The data document the dashboard renders: Fava's `dashboard` endpoint when
 * it answers, else a fresh `uv run mobile-snapshot` (same builder, same
 * derived block).
 */
export async function loadLiveData(file?: string): Promise<LiveData> {
  if (file)
    return {
      data: JSON.parse(readFileSync(file, "utf8")),
      source: "file",
      from: file,
    }
  return (await fromFava()) ?? fromCli()
}

// ── Check ──────────────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function describe(s: SpecSummary): string {
  const m = s.meta ?? {}
  return [
    `issue ${m.issueDate ?? "?"}  lens ${m.lens ?? "?"}  catalog v${m.catalogVersion ?? "?"}  elements: ${s.elementCount}`,
    `lead: ${describeElement(s.lead)}`,
    `hero: ${describeElement(s.hero)}`,
    `top-level order: ${s.topOrder.join(" > ") || "none"}`,
    `full order: ${s.order.join(" > ")}`,
    m.headline ? `headline: ${m.headline}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Anti-sameness: warnings when today's lead (type + key) or top-level order
 * equals one of the last 3 archived issues before today's date.
 */
function sameAsRecent(dir: string, s: SpecSummary): string[] {
  const today = s.meta?.issueDate
  const recent = archivedIssueDates(dir)
    .filter((d) => d !== today)
    .slice(0, 3)
  const out: string[] = []
  const order = s.topOrder.join(" > ")
  for (const d of recent) {
    const prev = readIssueSummary(dir, d)
    if (!prev) continue
    if (
      s.lead &&
      prev.lead?.type === s.lead.type &&
      prev.lead?.key === s.lead.key
    )
      out.push(`same lead as ${d}: ${describeElement(s.lead)}`)
    if (order && prev.topOrder.join(" > ") === order)
      out.push(`same top-level order as ${d}: ${order}`)
  }
  return out
}

/** Leaf-type changes against the last-known-good spec. */
function diffAgainst(prev: SpecSummary, next: SpecSummary): string {
  const count = (xs: string[]) => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
    return m
  }
  const a = count(prev.order)
  const b = count(next.order)
  const added: string[] = []
  const removed: string[] = []
  for (const t of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(t) ?? 0) - (a.get(t) ?? 0)
    if (d > 0) added.push(d > 1 ? `${t} x${d}` : t)
    if (d < 0) removed.push(-d > 1 ? `${t} x${-d}` : t)
  }
  const lead =
    prev.lead?.key === next.lead?.key
      ? `lead unchanged (${next.lead?.key ?? "none"})`
      : `lead ${prev.lead?.key ?? "none"} -> ${next.lead?.key ?? "none"}`
  return [
    `vs last-known-good (${prev.meta?.issueDate ?? "?"}): ${lead}`,
    `  added: ${added.join(", ") || "none"}  removed: ${removed.join(", ") || "none"}`,
  ].join("\n")
}

/** CLI-only standards lint: warnings, never blocking. */
function standardsWarnings(spec: Record<string, unknown>): string[] {
  const s = summarizeSpec(spec)
  const out: string[] = []
  if (s.elementCount < 10 || s.elementCount > 25)
    out.push(`hygiene: ${s.elementCount} elements (standards ask for 10 to 25)`)
  const notes = s.order.filter((t) => t === "Note").length
  if (notes > 1) out.push(`at most one Note per issue (found ${notes})`)
  if (!s.order.includes("Freshness")) out.push("no Freshness element")
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const dir = dashboardDir()
  const specPath = argValue(args, "--spec") ?? join(dir, "spec.json")
  const write = !args.includes("--no-write") && !argValue(args, "--spec")

  if (!existsSync(specPath)) {
    console.error(`No spec at ${specPath}`)
    process.exit(1)
  }
  const raw = readFileSync(specPath, "utf8")
  let spec: Record<string, unknown>
  try {
    spec = JSON.parse(raw)
  } catch (err) {
    console.error(
      `FAIL: ${specPath} is not valid JSON: ${(err as Error).message}`
    )
    process.exit(1)
  }

  const live = await loadLiveData(argValue(args, "--data"))
  console.log(`spec: ${specPath}`)
  console.log(
    `data: ${live.source} (${live.from}), asOf ${String(live.data.asOf)}`
  )

  const result = renderGate(spec, live.data)
  const summary = summarizeSpec(spec)
  console.log(describe(summary))
  if (result.issues.length > 0) console.log(`\n${formatIssues(result.issues)}`)
  for (const w of standardsWarnings(spec)) console.log(`warn  standards: ${w}`)
  const repeats = sameAsRecent(dir, summary)
  for (const w of repeats) console.log(`WARNING repeat: ${w}`)
  if (repeats.length > 0)
    console.log(
      "  Each issue is composed fresh from today's signals. Change the lead or the order, or justify the repeat in the changelog line's why (a pin or a forced repeat)."
    )

  if (!result.ok) {
    const n = result.issues.filter((i) => i.severity === "error").length
    console.log(`\nFAIL: ${n} error(s). spec.lkg.json is unchanged.`)
    process.exit(1)
  }

  const lkgPath = join(dir, "spec.lkg.json")
  if (existsSync(lkgPath)) {
    try {
      console.log(
        `\n${diffAgainst(summarizeSpec(JSON.parse(readFileSync(lkgPath, "utf8"))), summary)}`
      )
    } catch {
      // An unreadable lkg is replaced below.
    }
  }

  if (!write) {
    const d = (spec.meta as { issueDate?: unknown }).issueDate
    if (d !== localToday())
      console.log(
        `warn  meta.issueDate is ${String(d)}, not today (${localToday()}); a writing run would refuse it`
      )
    console.log("\nPASS (nothing written)")
    return
  }
  const issueDate = String((spec.meta as { issueDate: string }).issueDate)
  const today = localToday()
  if (issueDate !== today) {
    console.log(
      `\nFAIL: meta.issueDate is ${issueDate}, but today is ${today}. Set "issueDate": "${today}" in ${specPath} (compose today's issue, do not reuse an old one) and re-run. Nothing was written.`
    )
    process.exit(1)
  }
  mkdirSync(join(dir, "issues"), { recursive: true })
  writeFileSync(lkgPath, raw)
  writeFileSync(join(dir, "issues", `${issueDate}.json`), raw)
  console.log(`\nPASS: wrote spec.lkg.json and issues/${issueDate}.json`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
