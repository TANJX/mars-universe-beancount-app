// `just dashboard-look`: the daily agent's eyes. Opens the live Today page in
// headless Chrome, captures it at a few widths and themes, and measures what
// a reader would notice: holes inside panels, labels cut off, sideways
// overflow, how long the page runs, which tier rendered, console errors.
//
//   node --import ./apps/web/lib/runway/test/resolve-ts.mjs apps/web/scripts/dashboard-look.ts
//     [--base URL] [--out DIR] [--views wide,wide-dark,mid,phone]
//
// --base  the web app to look at (default http://localhost:8888, the
//         launchd release; the page reads spec.json live, so a draft shows
//         before `dashboard-check` promotes it),
// --out   where to write PNGs and report.json (default
//         $LEDGER_DIR/build/dashboard-look/<today>; build/ is gitignored, so
//         screenshots of real numbers never reach git),
// --views which views to capture, comma separated.
//
// Tall pages are cut into tiles so every image stays readable when an agent
// opens it. No dependencies: Chrome is driven over the DevTools protocol with
// Node's built-in WebSocket. CHROME overrides the browser path.
import { type ChildProcess, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ledgerDir, localToday } from "./dashboard-check"

// ── Views ──────────────────────────────────────────────────────────────

interface View {
  width: number
  height: number
  scheme: "light" | "dark"
  mobile: boolean
  /** What this view is for, printed in the report. */
  why: string
}

const VIEWS: Record<string, View> = {
  wide: {
    width: 1440,
    height: 900,
    scheme: "light",
    mobile: false,
    why: "laptop at full width: the layout as composed",
  },
  "wide-dark": {
    width: 1440,
    height: 900,
    scheme: "dark",
    mobile: false,
    why: "the same in dark: tags, tones and charts must stay legible",
  },
  mid: {
    width: 1024,
    height: 800,
    scheme: "light",
    mobile: false,
    why: "small window with the sidebar open: Grids collapse to one column",
  },
  phone: {
    width: 390,
    height: 844,
    scheme: "light",
    mobile: true,
    why: "phone: reading order and page length",
  },
}

/** Tiles are at most this many CSS pixels tall per pixel of width. */
const TILE_ASPECT = { desktop: 1.4, mobile: 2.6 }
/** A panel with more empty space than this at its bottom is a hole. */
const HOLE_PX = 96

// ── CDP ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

class Cdp {
  private id = 0
  private pending = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >()
  private listeners: ((method: string, params: Json) => void)[] = []
  private ws: WebSocket

  // A plain field, not a parameter property: Node strips types only.
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: Json
        error?: { message: string }
        method?: string
        params?: Json
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result ?? {})
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {})
      }
    })
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener("open", () => resolve(new Cdp(ws)))
      ws.addEventListener("error", () =>
        reject(new Error(`could not connect to ${url}`))
      )
    })
  }

  /** Every call times out, so a stuck page fails the run instead of hanging it. */
  send(method: string, params: Json = {}, timeoutMs = 30_000): Promise<Json> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  on(fn: (method: string, params: Json) => void) {
    this.listeners.push(fn)
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string } }
    if (r.exceptionDetails)
      throw new Error(`page script failed: ${r.exceptionDetails.text}`)
    return r.result?.value as T
  }

  close() {
    this.ws.close()
  }
}

function chromePath(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((p): p is string => !!p)
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    console.error("No Chrome found. Set CHROME to the browser binary.")
    process.exit(2)
  }
  return found
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function launch(): Promise<{
  proc: ChildProcess
  port: number
  profile: string
}> {
  // A throwaway profile: no stored theme, sidebar state or service worker,
  // so every run sees the page as a fresh visitor would.
  const profile = mkdtempSync(join(tmpdir(), "dashboard-look-"))
  const proc = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: "ignore" }
  )
  const portFile = join(profile, "DevToolsActivePort")
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0])
      if (port > 0) return { proc, port, profile }
    }
    await sleep(100)
  }
  proc.kill()
  throw new Error("Chrome did not start (no DevToolsActivePort)")
}

// ── Page measurements ──────────────────────────────────────────────────

interface Measure {
  tier: string | null
  headline: string | null
  lead: string | null
  /** Panel and tile titles in reading order at this width. */
  order: string[]
  /** Largest column count any Grid shows at this width. */
  maxColumns: number
  holes: { title: string; px: number }[]
  truncated: string[]
  overflowX: boolean
  /** Page height in screens of this view. */
  screens: number
  /** Screen (1-based) where the lead panel starts. */
  leadScreen: number | null
  contentHeight: number
  /** Images that failed (loaded empty) or never finished, by src host. */
  images: { broken: string[]; pending: string[] }
}

// Runs in the page. Plain JS in a string: it never sees the app's modules.
// Secondary text that may truncate by design carries data-trim-ok and is
// not reported; a cut-off title or payee is.
const MEASURE = `(() => {
  const root = document.querySelector("[data-dash-root]")
  const main = document.querySelector("main")
  const top = main ? main.getBoundingClientRect().top : 0
  const scrollH = main ? main.scrollHeight : document.documentElement.scrollHeight
  const viewH = window.innerHeight
  const panels = [...document.querySelectorAll('[data-dash="Panel"]')]
  const holes = []
  for (const p of panels) {
    const r = p.getBoundingClientRect()
    let bottom = r.top
    for (const el of p.querySelectorAll("*")) {
      const b = el.getBoundingClientRect()
      if (b.height > 0 && b.width > 0 && b.bottom > bottom) bottom = b.bottom
    }
    const px = Math.round(r.bottom - bottom - 12)
    if (px >= ${HOLE_PX}) holes.push({ title: p.dataset.title || "?", px })
  }
  const order = [...document.querySelectorAll('[data-dash="Panel"],[data-dash="StatTile"]')]
    .map((e) => ({ t: e.dataset.title || "?", y: Math.round(e.getBoundingClientRect().top), x: Math.round(e.getBoundingClientRect().left) }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((e) => e.t)
  const grids = [...document.querySelectorAll('[data-dash="Grid"]')]
  const maxColumns = Math.max(0, ...grids.map((g) => getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length))
  const truncated = root
    ? [...root.querySelectorAll(".truncate:not([data-trim-ok])")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => (e.textContent || "").trim().slice(0, 60))
        .filter(Boolean)
    : []
  const lead = document.querySelector('[data-dash="Panel"][data-lead]')
  const leadTop = lead ? lead.getBoundingClientRect().top - top + (main ? main.scrollTop : 0) : null
  const h1 = root ? root.querySelector("h1") : null
  return {
    tier: root ? root.dataset.dashTier : null,
    headline: h1 ? h1.textContent : null,
    lead: lead ? lead.dataset.title : null,
    order,
    maxColumns,
    holes,
    truncated: [...new Set(truncated)].slice(0, 12),
    overflowX: (main ? main.scrollWidth > main.clientWidth + 1 : false) ||
      document.documentElement.scrollWidth > window.innerWidth + 1,
    screens: Math.round((scrollH / Math.max(1, viewH - top)) * 10) / 10,
    leadScreen: leadTop === null ? null : Math.floor(leadTop / Math.max(1, viewH - top)) + 1,
    contentHeight: scrollH,
    images: (() => {
      const imgs = root ? [...root.querySelectorAll("img")] : []
      const host = (i) => { try { return new URL(i.currentSrc || i.src).pathname.split("/").filter(Boolean).slice(0, 2).join("/") } catch { return "?" } }
      return {
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map(host),
        pending: imgs.filter((i) => !i.complete).map(host),
      }
    })(),
  }
})()`

// Waits until the dashboard root exists and fonts and images settled.
const READY = `(async () => {
  for (let i = 0; i < 150; i++) {
    if (document.querySelector("[data-dash-root]")) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await document.fonts.ready
  await Promise.all([...document.images].map((img) => img.complete ? null :
    new Promise((r) => { img.addEventListener("load", r); img.addEventListener("error", r); setTimeout(r, 3000) })))
  // decode() on a lazy image that never started loading waits forever: cap it.
  await Promise.all([...document.images].map((img) => Promise.race([
    img.decode().catch(() => null),
    new Promise((r) => setTimeout(r, 2000)),
  ])))
  await new Promise((r) => setTimeout(r, 400))
  return !!document.querySelector("[data-dash-root]")
})()`

// ── One view ───────────────────────────────────────────────────────────

interface ViewResult {
  view: string
  why: string
  width: number
  scheme: string
  images: string[]
  measure: Measure | null
  errors: string[]
}

async function capture(
  port: number,
  base: string,
  name: string,
  v: View,
  out: string
): Promise<ViewResult> {
  const target = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json()) as { webSocketDebuggerUrl: string; id: string }
  const cdp = await Cdp.open(target.webSocketDebuggerUrl)
  const errors: string[] = []
  cdp.on((method, params) => {
    if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails as {
        text?: string
        exception?: { description?: string }
      }
      errors.push(d.exception?.description?.split("\n")[0] ?? d.text ?? "?")
    } else if (method === "Runtime.consoleAPICalled") {
      if (params.type === "error") {
        const args = (
          params.args as { value?: unknown; description?: string }[]
        )
          .map((a) => String(a.value ?? a.description ?? ""))
          .join(" ")
        errors.push(args.slice(0, 200))
      }
    }
  })
  await cdp.send("Runtime.enable")
  await cdp.send("Page.enable")
  // First-visit chrome that a fresh profile would show over the issue.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("demo-welcome-dismissed-v1", "1") } catch {}`,
  })
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: v.scheme }],
  })
  const metrics = (height: number) =>
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width: v.width,
      height,
      deviceScaleFactor: 1,
      mobile: v.mobile,
    })
  await metrics(v.height)
  if (v.mobile)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  await cdp.send("Page.navigate", { url: `${base}/today` })
  const ready = await cdp.eval<boolean>(READY)
  if (!ready) errors.push("the dashboard never rendered (no [data-dash-root])")

  const measure = ready ? await cdp.eval<Measure>(MEASURE) : null

  // Grow the window until the page's own scroller has nothing left to
  // scroll, so one capture holds the whole issue.
  const overflow = await cdp.eval<number>(
    `(() => { const m = document.querySelector("main"); return m ? m.scrollHeight - m.clientHeight : 0 })()`
  )
  const fullHeight = v.height + Math.max(0, overflow)
  await metrics(fullHeight)
  // Lazy images below the first screen start loading only now; judge them
  // after that (the layout measures above stay at the real window size).
  await cdp.eval<boolean>(READY)
  if (measure) measure.images = (await cdp.eval<Measure>(MEASURE)).images

  const tileH = Math.round(
    v.width * (v.mobile ? TILE_ASPECT.mobile : TILE_ASPECT.desktop)
  )
  const images: string[] = []
  for (let y = 0, i = 1; y < fullHeight; y += tileH, i++) {
    const h = Math.min(tileH, fullHeight - y)
    if (h < 80 && i > 1) break
    const shot = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y, width: v.width, height: h, scale: 1 },
      // The window already holds the whole page; capturing beyond it makes
      // Chrome re-lay it out mid-capture and drops decoded images.
      captureBeyondViewport: false,
    })) as { data: string }
    const file = join(out, `${name}-${i}.png`)
    writeFileSync(file, Buffer.from(shot.data, "base64"))
    images.push(file)
  }
  cdp.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
  return {
    view: name,
    why: v.why,
    width: v.width,
    scheme: v.scheme,
    images,
    measure,
    errors,
  }
}

// ── Report ─────────────────────────────────────────────────────────────

function flags(r: ViewResult): string[] {
  const m = r.measure
  if (!m) return ["did not render"]
  const f: string[] = []
  if (m.tier !== "spec") f.push(`showing tier "${m.tier}", not today's spec`)
  if (!m.lead) f.push("no panel is marked lead")
  for (const h of m.holes) f.push(`hole: "${h.title}" has ${h.px}px empty`)
  if (m.truncated.length)
    f.push(`cut off: ${m.truncated.map((t) => `"${t}"`).join(", ")}`)
  if (m.overflowX) f.push("scrolls sideways")
  if (m.images.broken.length)
    f.push(
      `${m.images.broken.length} images failed: ${[...new Set(m.images.broken)].join(", ")}`
    )
  if (m.images.pending.length)
    f.push(
      `${m.images.pending.length} images still loading: ${[...new Set(m.images.pending)].join(", ")}`
    )
  if (r.view === "phone" && m.screens > 5)
    f.push(`phone page runs ${m.screens} screens`)
  if (r.view === "wide" && m.leadScreen !== null && m.leadScreen > 1)
    f.push(`lead starts on screen ${m.leadScreen}`)
  for (const e of r.errors) f.push(`console: ${e}`)
  return f
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const base = (arg("--base") ?? "http://localhost:8888").replace(/\/$/, "")
  const out =
    arg("--out") ?? join(ledgerDir(), "build", "dashboard-look", localToday())
  const names = (arg("--views") ?? Object.keys(VIEWS).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const n of names)
    if (!VIEWS[n]) {
      console.error(`Unknown view "${n}". Views: ${Object.keys(VIEWS)}`)
      process.exit(2)
    }

  try {
    await fetch(`${base}/today`, { method: "HEAD" })
  } catch {
    console.error(`${base} is not answering. Is the web app running?`)
    process.exit(2)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const { proc, port, profile } = await launch()
  const results: ViewResult[] = []
  try {
    for (const n of names)
      results.push(await capture(port, base, n, VIEWS[n], out))
  } finally {
    // Chrome keeps writing its profile for a moment after the signal.
    const exited = new Promise((r) => proc.once("exit", r))
    proc.kill()
    await Promise.race([exited, sleep(3000)])
    try {
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    } catch {
      // A leftover temp profile is harmless; the OS clears tmp.
    }
  }

  const report = results.map((r) => ({ ...r, flags: flags(r) }))
  writeFileSync(
    join(out, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  )

  const first = report.find((r) => r.measure)?.measure
  console.log(`look: ${base}/today -> ${out}`)
  if (first?.headline) console.log(`headline: ${first.headline}`)
  if (first) console.log(`lead: ${first.lead ?? "none"}  tier: ${first.tier}`)
  let total = 0
  for (const r of report) {
    const m = r.measure
    console.log(
      `\n${r.view} (${r.width}px ${r.scheme}): ${r.why}` +
        (m ? `\n  columns ${m.maxColumns}, ${m.screens} screens` : "")
    )
    if (m && (r.view === "wide" || r.view === "phone"))
      console.log(`  order: ${m.order.join(" > ")}`)
    for (const f of r.flags) console.log(`  ! ${f}`)
    if (r.flags.length === 0) console.log("  no flags")
    for (const img of r.images) console.log(`  ${img}`)
    total += r.flags.length
  }
  console.log(
    `\n${total} flag${total === 1 ? "" : "s"}. Open every image before judging; the flags only catch what can be measured.`
  )
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
