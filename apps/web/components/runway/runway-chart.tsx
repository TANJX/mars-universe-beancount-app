"use client"

// The runway chart's plot, hand-built in SVG: one frame (axes, event lane,
// warning lines and pills, crosshair, scrub, tooltip) shared by the three
// views, plus the marks each view draws inside it. Straight segments between
// month points, no strokes between bands; a 2px card gap only where the
// family changes.

import * as React from "react"

import {
  type ChartEvent,
  type ChartWarning,
  type GlyphType,
  type Layer,
  warningPills,
  xLabels,
  type YScale,
  yScale,
} from "@/lib/runway/chart"
import { cn } from "@/lib/utils"

import type { Scrub } from "./use-scrub"

// ---------------------------------------------------------------- geometry

export interface Geom {
  w: number
  h: number
  pad: { l: number; r: number; t: number; b: number }
  ph: number
  step: number
  top: number
  bot: number
  x: (i: number) => number
}

export interface YAxis extends YScale {
  y: (v: number) => number
  fmt: (v: number) => string
}

function makeGeom(w: number, h: number, pad: Geom["pad"], n: number): Geom {
  const pw = Math.max(10, w - pad.l - pad.r)
  const ph = Math.max(10, h - pad.t - pad.b)
  const step = pw / Math.max(1, n)
  return {
    w,
    h,
    pad,
    ph,
    step,
    top: pad.t,
    bot: pad.t + ph,
    x: (i) => pad.l + (i + 0.5) * step,
  }
}

function makeY(
  g: Geom,
  maxV: number,
  minV: number,
  fmt: (v: number) => string,
  fixed?: { lo: number; hi: number }
): YAxis {
  const s = yScale(g.ph, fixed ? fixed.hi / 1.06 : maxV, minV)
  const lo = fixed ? fixed.lo : s.lo
  const hi = fixed ? fixed.hi : s.hi
  return {
    ...s,
    lo,
    hi,
    fmt,
    y: (v) => g.top + g.ph - ((v - lo) / (hi - lo || 1)) * g.ph,
  }
}

/** Polyline points; `from` is the month index of vals[0]. */
export const pts = (g: Geom, y: YAxis, vals: number[], from = 0) =>
  vals
    .map((v, i) => `${g.x(i + from).toFixed(1)},${y.y(v).toFixed(1)}`)
    .join(" ")

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const w = Math.round(el.clientWidth)
      const h = Math.round(el.clientHeight)
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

// ---------------------------------------------------------------- glyphs

/** One event glyph; `hollow` marks an event only the comparison run has. */
export function Glyph({
  type,
  x,
  y,
  hollow = false,
  scale = 1,
}: {
  type: GlyphType
  x: number
  y: number
  hollow?: boolean
  /** Below 1 on a crowded lane (many history months). */
  scale?: number
}) {
  if (scale !== 1)
    return (
      <g transform={`translate(${x} ${y}) scale(${scale})`}>
        <Glyph type={type} x={0} y={0} hollow={hollow} />
      </g>
    )
  const r = 4.5
  const paint = hollow
    ? { fill: "none", stroke: "var(--runway-glyph)", strokeWidth: 1.25 }
    : { fill: "var(--runway-glyph)" }
  switch (type) {
    case "raise":
      return (
        <path
          d={`M${x},${y - r}L${x + r},${y + r * 0.8}L${x - r},${y + r * 0.8}Z`}
          {...paint}
        />
      )
    case "cut":
      return (
        <path
          d={`M${x},${y + r}L${x + r},${y - r * 0.8}L${x - r},${y - r * 0.8}Z`}
          {...paint}
        />
      )
    case "ira":
      return <circle cx={x} cy={y} r={r - 0.5} {...paint} />
    case "k401": {
      const a = 1.6
      return (
        <path
          d={`M${x - a},${y - r}H${x + a}V${y - a}H${x + r}V${y + a}H${x + a}V${y + r}H${x - a}V${y + a}H${x - r}V${y - a}H${x - a}Z`}
          {...paint}
        />
      )
    }
    case "hsa":
      return (
        <rect
          x={x - r}
          y={y - 2.5}
          width={2 * r}
          height={5}
          rx={2.5}
          {...paint}
        />
      )
    case "limit":
      return (
        <rect
          x={x - r + 0.8}
          y={y - r + 0.8}
          width={2 * r - 1.6}
          height={2 * r - 1.6}
          rx={1}
          {...paint}
        />
      )
    case "job":
      return (
        <path
          d={`M${x},${y - r - 0.5}L${x + r + 0.5},${y}L${x},${y + r + 0.5}L${x - r - 0.5},${y}Z`}
          {...paint}
        />
      )
    case "forfeit":
      return (
        <path
          d={`M${x - 3.5},${y - 3.5}L${x + 3.5},${y + 3.5}M${x + 3.5},${y - 3.5}L${x - 3.5},${y + 3.5}`}
          fill="none"
          stroke="var(--runway-glyph)"
          strokeWidth={hollow ? 1.25 : 2}
          strokeDasharray={hollow ? "2 1.5" : undefined}
          strokeLinecap="round"
        />
      )
    case "bill":
      return (
        <rect x={x - 3} y={y - r} width={6} height={2 * r} rx={1} {...paint} />
      )
    default:
      return <circle cx={x} cy={y} r={2.5} {...paint} />
  }
}

export function GlyphIcon({
  type,
  hollow = false,
}: {
  type: GlyphType
  hollow?: boolean
}) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      className="shrink-0"
    >
      <Glyph type={type} x={5.5} y={5.5} hollow={hollow} />
    </svg>
  )
}

/** Dashed comparison line, as drawn in the plot. */
export function DashIcon() {
  return (
    <svg width="16" height="6" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        x2="16"
        y1="3"
        y2="3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
    </svg>
  )
}

/** 45 degree hatch in the warning color: not covered, or below $0. */
export function Hatch({ id }: { id: string }) {
  return (
    <pattern
      id={id}
      width="4"
      height="4"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect
        width="4"
        height="4"
        fill="color-mix(in oklch, var(--runway-crit) 8%, transparent)"
      />
      <line
        x1="0"
        y1="0"
        x2="0"
        y2="4"
        stroke="var(--runway-crit)"
        strokeWidth="1.5"
      />
    </pattern>
  )
}

export function HatchSwatch() {
  const id = `hatch-sw-${React.useId().replace(/:/g, "")}`
  return (
    <svg
      width="8"
      height="8"
      aria-hidden="true"
      className="shrink-0 rounded-[2px]"
    >
      <defs>
        <Hatch id={id} />
      </defs>
      <rect width="8" height="8" fill={`url(#${id})`} />
    </svg>
  )
}

// ---------------------------------------------------------------- frame

export interface NetPanel {
  values: number[]
  /** The comparison run's net, null in months it does not cover. */
  other: (number | null)[] | null
  label: string
}

export interface FrameProps {
  months: string[]
  compact: boolean
  /** Data range of the main plot. */
  max: number
  min?: number
  /** A fixed domain (the share view is 0 to 100%). */
  domain?: { lo: number; hi: number }
  fmt: (v: number) => string
  marks: (g: Geom, y: YAxis, ids: MarkIds) => React.ReactNode
  /** Crosshair dots (plot px) for month i. */
  dots?: (i: number, g: Geom, y: YAxis) => number[]
  events: ChartEvent[]
  warnings: ChartWarning[]
  /** Aligned panel of monthly net under the main plot (Cash view). */
  net?: NetPanel | null
  /** Months of history before the forecast (0 for none). Draws the "Today"
   * divider and lets marks fade the forecast through `ids.fade`. */
  split?: number
  scrub: Scrub
  /** Readout for month i; `docked` is true on a narrow plot (phone). */
  tooltip: (i: number, docked: boolean) => React.ReactNode
  ariaLabel: string
  live: string
}

export interface MarkIds {
  hatch: string
  /** Mask that draws the forecast months lighter; null without history. */
  fade: string | null
}

/** Opacity of forecast marks next to solid history. */
const FORECAST_OPACITY = 0.68

const NET_H = { wide: 76, narrow: 64 }

export function ChartFrame({
  months,
  compact,
  max,
  min = 0,
  domain,
  fmt,
  marks,
  dots,
  events,
  warnings,
  net,
  split = 0,
  scrub,
  tooltip,
  ariaLabel,
  live,
}: FrameProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { w, h } = useSize(ref)
  const uid = React.useId().replace(/:/g, "")
  const n = months.length
  const narrow = w < 480
  const netH = net && !compact ? (narrow ? NET_H.narrow : NET_H.wide) : 0
  const mainH = Math.max(40, h - netH)
  const pad = {
    l: narrow ? 36 : 44,
    r: 10,
    t: compact ? 6 : 26,
    b: compact ? 18 : 40,
  }
  const g = makeGeom(w, mainH, pad, n)
  const y = makeY(g, max, min, fmt, domain)
  const docked = w < 560
  const i = scrub.index

  const indexAt = (clientX: number) => {
    const el = ref.current
    if (!el || n === 0) return null
    const px = clientX - el.getBoundingClientRect().left
    return Math.max(0, Math.min(n - 1, Math.floor((px - pad.l) / g.step)))
  }

  const ready = w > 0 && h > 0 && n > 0
  const today = split > 0 && split < n ? pad.l + split * g.step : null
  const fade = today != null ? `fade-${uid}` : null
  const tipX = i != null ? g.x(i) : 0
  const flip = tipX > w / 2

  return (
    <div className="relative h-full w-full">
      <div
        ref={ref}
        role="group"
        aria-roledescription="chart"
        aria-label={`${ariaLabel} Use the arrow keys to step through months.`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart takes arrow keys to scrub.
        tabIndex={0}
        className="h-full w-full cursor-crosshair touch-pan-y select-none rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        {...scrub.bind(indexAt)}
      >
        {ready ? (
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            aria-hidden="true"
            className="block overflow-visible"
          >
            <defs>
              <Hatch id={`hatch-${uid}`} />
              {fade && today != null ? (
                <mask
                  id={fade}
                  maskUnits="userSpaceOnUse"
                  x={0}
                  y={0}
                  width={w}
                  height={h}
                  style={{ maskType: "alpha" }}
                >
                  <rect x={0} y={0} width={today} height={h} fill="#fff" />
                  <rect
                    x={today}
                    y={0}
                    width={Math.max(0, w - today)}
                    height={h}
                    fill="#fff"
                    fillOpacity={FORECAST_OPACITY}
                  />
                </mask>
              ) : null}
            </defs>
            <YAxisMarks g={g} y={y} />
            {marks(g, y, { hatch: `hatch-${uid}`, fade })}
            {today != null ? (
              <TodayDivider
                x={today}
                top={compact ? g.top : g.top - 4}
                bot={g.bot}
                label={!compact}
              />
            ) : null}
            <Lanes
              g={g}
              events={compact ? [] : events}
              warnings={warnings}
              pills={!compact}
              reserve={today != null && !compact ? today + 22 : null}
            />
            {xLabels(months, g.x).map((l) => (
              <text
                key={l.i}
                x={Math.max(pad.l + 18, Math.min(w - pad.r - 18, l.x))}
                y={mainH - (compact ? 4 : 6)}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[10.5px]"
              >
                {l.label}
              </text>
            ))}
            {netH ? (
              <NetMarks
                net={net as NetPanel}
                top={mainH}
                height={netH}
                g={g}
                hatch={`hatch-${uid}`}
                index={i}
                split={today != null ? split : 0}
              />
            ) : null}
            {i != null ? (
              <g pointerEvents="none">
                <line
                  x1={g.x(i)}
                  x2={g.x(i)}
                  y1={g.top}
                  y2={g.bot}
                  stroke="var(--foreground)"
                  strokeOpacity={0.45}
                />
                {(dots?.(i, g, y) ?? []).map((dy, k) => (
                  <circle
                    key={k}
                    cx={g.x(i)}
                    cy={dy}
                    r={3.5}
                    fill="var(--card)"
                    stroke="var(--foreground)"
                    strokeWidth={1.5}
                  />
                ))}
              </g>
            ) : null}
          </svg>
        ) : null}
      </div>
      {ready && !compact ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-10 rounded-lg border bg-card px-2.5 py-2 text-[11.5px] shadow-[0_1px_2px_oklch(0.2_0.01_40/0.06),0_6px_16px_oklch(0.2_0.01_40/0.1)] transition-opacity duration-120 ease-out motion-reduce:transition-none",
            docked
              ? "top-0 right-2 left-2 px-2 py-1.5"
              : "top-0 left-0 w-max min-w-48 max-w-60",
            i == null ? "opacity-0" : "opacity-100"
          )}
          style={
            docked || i == null
              ? undefined
              : {
                  transform: `translate(${tipX}px, ${pad.t}px) translateX(${flip ? "calc(-100% - 12px)" : "12px"})`,
                }
          }
        >
          {i != null ? tooltip(i, docked) : null}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {live}
      </div>
    </div>
  )
}

function YAxisMarks({ g, y }: { g: Geom; y: YAxis }) {
  return (
    <g>
      {y.ticks.map((t) => {
        const yy = y.y(t)
        return (
          <g key={t}>
            <line
              x1={g.pad.l}
              x2={g.w - g.pad.r}
              y1={yy}
              y2={yy}
              stroke={
                t === 0
                  ? "color-mix(in oklch, var(--foreground) 22%, transparent)"
                  : "var(--border)"
              }
            />
            <text
              x={g.pad.l - 6}
              y={yy + 3.5}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10.5px]"
            >
              {y.fmt(t)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** Where the ledger's months end and the forecast begins. */
function TodayDivider({
  x,
  top,
  bot,
  label,
}: {
  x: number
  top: number
  bot: number
  label: boolean
}) {
  return (
    <g pointerEvents="none">
      <line
        x1={x}
        x2={x}
        y1={top}
        y2={bot}
        stroke="var(--foreground)"
        strokeOpacity={0.55}
        strokeWidth={1}
      />
      {label ? (
        <text
          x={x}
          y={top - 5}
          textAnchor="middle"
          className="fill-muted-foreground font-medium text-[10.5px]"
        >
          Today
        </text>
      ) : null}
    </g>
  )
}

/** Warning lines through the plot with pills in the lane above it; event
 * glyphs in the lane under it. `reserve` keeps pills right of that x (the
 * "Today" label sits left of it). */
function Lanes({
  g,
  events,
  warnings,
  pills,
  reserve = null,
}: {
  g: Geom
  events: ChartEvent[]
  warnings: ChartWarning[]
  pills: boolean
  reserve?: number | null
}) {
  const placed: { x: number; w: number; tone: string; text: string }[] = []
  let right = reserve ?? -Infinity
  for (const p of warningPills(warnings)) {
    const tw = p.text.length * 5.9 + 16
    let px = Math.max(g.pad.l, Math.min(g.w - g.pad.r - tw, g.x(p.i) - tw / 2))
    if (px < right + 4) px = right + 4
    if (px + tw > g.w - g.pad.r + 0.5) continue
    placed.push({ x: px, w: tw, tone: p.tone, text: p.text })
    right = px + tw
  }
  const byMonth = new Map<number, ChartEvent[]>()
  for (const e of events) byMonth.set(e.i, [...(byMonth.get(e.i) ?? []), e])
  return (
    <g pointerEvents="none">
      {warningPills(warnings).map((p) => (
        <line
          key={`wl-${p.i}`}
          x1={g.x(p.i)}
          x2={g.x(p.i)}
          y1={g.top}
          y2={g.bot}
          stroke={
            p.tone === "rose" ? "var(--runway-crit)" : "var(--runway-warn)"
          }
          strokeDasharray="2 2"
        />
      ))}
      {pills
        ? placed.map((p) => (
            <g key={`wp-${p.x}`}>
              <rect
                x={p.x}
                y={g.top - 21}
                width={p.w}
                height={17}
                rx={8.5}
                fill={
                  p.tone === "rose"
                    ? "color-mix(in oklch, var(--runway-crit) 12%, transparent)"
                    : "color-mix(in oklch, var(--runway-warn) 16%, transparent)"
                }
              />
              <text
                x={p.x + p.w / 2}
                y={g.top - 9}
                textAnchor="middle"
                fill={
                  p.tone === "rose"
                    ? "var(--runway-crit)"
                    : "var(--runway-warn)"
                }
                className="font-medium text-[10.5px]"
              >
                {p.text}
              </text>
            </g>
          ))
        : null}
      {[...byMonth.entries()].flatMap(([i, list]) => {
        const nEv = list.length
        const flat = nEv * 10 <= g.step
        // Narrow months (a long history on a phone) stack one column and
        // shrink the glyphs so neighbors never touch.
        const column = !flat && g.step < 20
        const cols = flat ? nEv : column ? 1 : Math.ceil(nEv / 2)
        const scale = column
          ? Math.max(0.5, Math.min(0.8, (g.step - 1) / 9, 22 / (nEv * 9)))
          : 1
        const gapY = 9 * scale + 1
        return list.map((e, k) => {
          const col = flat || column ? (column ? 0 : k) : Math.floor(k / 2)
          const row = flat ? 0 : column ? k : k % 2
          const x = g.x(i) + (col - (cols - 1) / 2) * 10
          const yy = column
            ? g.bot + 6 + row * gapY
            : flat || nEv === 1
              ? g.bot + 11
              : g.bot + 8 + row * 10
          return (
            <Glyph
              key={`ev-${i}-${e.label}-${e.other ? "o" : "m"}`}
              type={e.type}
              x={Math.round(x * 10) / 10}
              y={Math.round(yy * 10) / 10}
              hollow={e.other}
              scale={scale}
            />
          )
        })
      })}
    </g>
  )
}

/** Monthly net as small bars around $0, aligned with the plot above. */
function NetMarks({
  net,
  top,
  height,
  g,
  hatch,
  index,
  split,
}: {
  net: NetPanel
  top: number
  height: number
  g: Geom
  hatch: string
  index: number | null
  /** First forecast month; its bars and later ones draw lighter. */
  split: number
}) {
  const t = top + 14
  const b = top + height - 4
  const all = [
    ...net.values,
    ...(net.other ?? []).filter((v): v is number => v != null),
  ]
  const lo = Math.min(0, ...all)
  const hi = Math.max(0, ...all)
  const range = hi - lo || 1
  const y = (v: number) => b - ((v - lo) / range) * (b - t)
  const bw = Math.max(3, Math.min(14, g.step * 0.55))
  return (
    <g>
      <line
        x1={g.pad.l}
        x2={g.w - g.pad.r}
        y1={y(0)}
        y2={y(0)}
        stroke="color-mix(in oklch, var(--foreground) 22%, transparent)"
      />
      <text
        x={g.pad.l - 6}
        y={y(0) + 3.5}
        textAnchor="end"
        className="fill-muted-foreground font-mono text-[10.5px]"
      >
        $0
      </text>
      <text
        x={g.pad.l + 2}
        y={top + 9}
        className="fill-muted-foreground text-[10.5px]"
      >
        {net.label}
      </text>
      {net.values.map((v, i) => {
        const x = g.x(i) - bw / 2
        const y0 = y(0)
        const y1 = y(v)
        const o = net.other?.[i]
        return (
          <g key={i}>
            <rect
              x={x}
              y={Math.min(y0, y1)}
              width={bw}
              height={Math.max(1, Math.abs(y1 - y0))}
              rx={1.5}
              fill={v < 0 ? `url(#${hatch})` : "var(--flow-out)"}
              fillOpacity={split > 0 && i >= split ? FORECAST_OPACITY : 1}
            />
            {o != null && Math.abs(o - v) >= 0.5 ? (
              <rect
                x={x - 1}
                y={Math.min(y0, y(o))}
                width={bw + 2}
                height={Math.max(1, Math.abs(y(o) - y0))}
                rx={1.5}
                fill="none"
                stroke="var(--foreground)"
                strokeWidth={1.25}
                strokeDasharray="3 2"
              />
            ) : null}
          </g>
        )
      })}
      {index != null ? (
        <line
          x1={g.x(index)}
          x2={g.x(index)}
          y1={t}
          y2={b}
          stroke="var(--foreground)"
          strokeOpacity={0.45}
          pointerEvents="none"
        />
      ) : null}
    </g>
  )
}

// ---------------------------------------------------------------- marks

/** Stacked bands with a 2px card gap only between families, an optional
 * hatched area below $0 (checking that nothing could cover), and an
 * optional dashed comparison total with its end difference label. */
export function StackMarks({
  g,
  y,
  layers,
  deficit,
  hatch,
  compare,
  compact,
  fade = null,
}: {
  g: Geom
  y: YAxis
  layers: Layer[]
  deficit?: number[] | null
  hatch: string
  /** `from` is the month index of totals[0] (the first forecast month). */
  compare?: {
    totals: number[]
    label: string
    diff: string
    from?: number
  } | null
  compact: boolean
  /** Mask id that draws the forecast months lighter. */
  fade?: string | null
}) {
  const n = layers[0]?.y1.length ?? 0
  const band = (L: Layer) => {
    let d = "M"
    for (let i = 0; i < n; i++)
      d += `${g.x(i).toFixed(1)},${y.y(L.y1[i]).toFixed(1)}L`
    for (let i = n - 1; i >= 0; i--)
      d += `${g.x(i).toFixed(1)},${y.y(L.y0[i]).toFixed(1)}${i ? "L" : ""}`
    return `${d}Z`
  }
  const last = n - 1
  const top = layers.at(-1)?.y1 ?? []
  const from = compare?.from ?? 0
  const cLast = compare ? compare.totals.length - 1 : -1
  return (
    <g>
      <g mask={fade ? `url(#${fade})` : undefined}>
        {layers.map((L) => (
          <path key={L.def.id} d={band(L)} fill={`var(${L.def.token})`} />
        ))}
        {layers
          .slice(0, -1)
          .map((L, k) =>
            L.def.group !== layers[k + 1].def.group ? (
              <polyline
                key={`gap-${L.def.id}`}
                points={pts(g, y, L.y1)}
                fill="none"
                stroke="var(--card)"
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ) : null
          )}
        {deficit?.some((v) => v < 0) ? (
          <path
            d={`M${g.x(0)},${y.y(0)}L${pts(g, y, deficit).replace(/ /g, "L")}L${g.x(last)},${y.y(0)}Z`}
            fill={`url(#${hatch})`}
            stroke="var(--runway-crit)"
            strokeWidth={1}
          />
        ) : null}
      </g>
      {compare ? (
        <>
          <polyline
            points={pts(g, y, compare.totals, from)}
            fill="none"
            stroke="var(--card)"
            strokeWidth={4}
            strokeLinejoin="round"
          />
          <polyline
            points={pts(g, y, compare.totals, from)}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
          {!compact && last >= 0 && cLast >= 0 ? (
            <HaloText
              x={g.x(last) - 2}
              y={Math.max(
                g.top - 2,
                Math.min(y.y(compare.totals[cLast]), y.y(top[last] ?? 0)) - 7
              )}
              anchor="end"
            >
              {`${compare.label} ${compare.diff}`}
            </HaloText>
          ) : null}
        </>
      ) : null}
    </g>
  )
}

/** A label on the plot with a card-colored halo so it reads over bands. */
export function HaloText({
  x,
  y,
  anchor = "start",
  children,
}: {
  x: number
  y: number
  anchor?: "start" | "end" | "middle"
  children: string
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fill="var(--foreground)"
      stroke="var(--card)"
      strokeWidth={3}
      paintOrder="stroke"
      className="font-medium text-[10.5px]"
    >
      {children}
    </text>
  )
}

/** Horizontal dashed reference line (emergency fund target, play cap). */
export function RefLine({
  g,
  yy,
  label,
  side,
}: {
  g: Geom
  yy: number
  label: string
  side: "start" | "end"
}) {
  return (
    <g pointerEvents="none">
      <line
        x1={g.pad.l}
        x2={g.w - g.pad.r}
        y1={yy}
        y2={yy}
        stroke="var(--foreground)"
        strokeOpacity={0.6}
        strokeDasharray="2 2"
      />
      <HaloText
        x={side === "start" ? g.pad.l + 4 : g.w - g.pad.r - 2}
        y={yy - 5}
        anchor={side}
      >
        {label}
      </HaloText>
    </g>
  )
}

/** Dashed line for a comparison series that is not a stack total. */
export function DashedLine({
  g,
  y,
  vals,
  from = 0,
}: {
  g: Geom
  y: YAxis
  vals: number[]
  /** Month index of vals[0]. */
  from?: number
}) {
  return (
    <g pointerEvents="none">
      <polyline
        points={pts(g, y, vals, from)}
        fill="none"
        stroke="var(--card)"
        strokeWidth={4}
        strokeLinejoin="round"
      />
      <polyline
        points={pts(g, y, vals, from)}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        strokeLinejoin="round"
      />
    </g>
  )
}
