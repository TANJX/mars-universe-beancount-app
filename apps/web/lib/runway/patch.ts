// Patches over plain JSON, the twin of the Fava extension's runway_patch.py
// (keep the two in step).
//
// A scenario is a patch over its person's plan. Objects merge key by key; a
// list whose items all carry an `id` (or, failing that, a `from` month)
// merges item by item on that key, and `{ id: x, remove: true }` drops an
// item. Anything else (scalars, other lists) replaces. A key set to null in
// a patch sets it to null.
//
// Erasable TypeScript only so `node --test` can run it from source.

type Json = unknown
type Obj = Record<string, unknown>

const KEYS = ["id", "from"] as const
const REMOVE = "remove"

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

const clone = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)

/** The merge key every item of every list carries, or null. */
export function listKey(...lists: unknown[]): string | null {
  const items = lists.flatMap((l) => (Array.isArray(l) ? l : []))
  if (!items.length || !items.every(isObj)) return null
  for (const key of KEYS) {
    if (!items.every((x) => (x as Obj)[key] != null)) continue
    for (const l of lists) {
      const vals = (Array.isArray(l) ? l : []).map((x) => String(x[key]))
      if (new Set(vals).size !== vals.length) return null
    }
    return key
  }
  return null
}

const kv = (x: unknown, key: string) => String((x as Obj)[key])

function stripRemove(x: unknown): unknown {
  if (isObj(x) && REMOVE in x) {
    const { [REMOVE]: _, ...rest } = x
    return clone(rest)
  }
  return clone(x)
}

/** `base` with `patch` applied; neither is modified. */
export function applyPatch<T>(base: T, patch: unknown): T {
  if (isObj(base) && isObj(patch)) {
    const out: Obj = clone(base) as Obj
    for (const [k, v] of Object.entries(patch)) {
      if (k in out) out[k] = applyPatch(out[k], v)
      else if (Array.isArray(v) && listKey(v))
        out[k] = v.filter((x) => !(x as Obj)[REMOVE]).map(stripRemove)
      else out[k] = clone(v)
    }
    return out as T
  }
  if (Array.isArray(base) && Array.isArray(patch) && patch.length) {
    const key = base.length ? listKey(base, patch) : listKey(patch)
    if (key) {
      const out = clone(base) as unknown[]
      for (const item of patch) {
        const idx = out.findIndex((x) => kv(x, key) === kv(item, key))
        if ((item as Obj)[REMOVE] === true) {
          if (idx >= 0) out.splice(idx, 1)
        } else if (idx >= 0) out[idx] = applyPatch(out[idx], stripRemove(item))
        else out.push(stripRemove(item))
      }
      return out as T
    }
  }
  return clone(patch) as T
}

/** The smallest patch with applyPatch(old, patch) deep-equal to `new`. */
export function diffPatch(next: Json, prev: Json): Json {
  if (isObj(next) && isObj(prev)) {
    const out: Obj = {}
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) continue
      if (!(k in prev) || prev[k] === undefined) {
        out[k] = clone(v)
        continue
      }
      if (deepEqual(v, prev[k])) continue
      const key =
        Array.isArray(v) && Array.isArray(prev[k]) ? listKey(v, prev[k]) : null
      if (isObj(v) && isObj(prev[k])) {
        const sub = diffPatch(v, prev[k]) as Obj
        if (Object.keys(sub).length) out[k] = sub
      } else if (key) {
        const sub = diffList(v as unknown[], prev[k] as unknown[], key)
        if (sub.length) out[k] = sub
      } else out[k] = clone(v)
    }
    for (const k of Object.keys(prev))
      if (prev[k] !== undefined && (!(k in next) || next[k] === undefined))
        out[k] = null
    return out
  }
  return clone(next)
}

function diffList(next: unknown[], prev: unknown[], key: string): unknown[] {
  const prevBy = new Map(prev.map((x) => [kv(x, key), x]))
  const nextKeys = new Set(next.map((x) => kv(x, key)))
  const out: unknown[] = []
  for (const item of next) {
    const was = prevBy.get(kv(item, key))
    if (was === undefined) out.push(clone(item))
    else if (!deepEqual(item, was)) {
      const sub = diffPatch(item, was) as Obj
      out.push({ ...sub, [key]: (item as Obj)[key] })
    }
  }
  for (const x of prev)
    if (!nextKeys.has(kv(x, key)))
      out.push({ [key]: (x as Obj)[key], [REMOVE]: true })
  return out
}

/** Leaf values a patch sets (an added or removed list item counts once). */
export function countChanges(patch: Json): number {
  if (isObj(patch)) {
    if (patch[REMOVE] === true) return 1
    return Object.entries(patch).reduce(
      (n, [, v]) => n + (isObj(v) || Array.isArray(v) ? countChanges(v) : 1),
      0
    )
  }
  if (Array.isArray(patch)) {
    if (listKey(patch))
      return patch.reduce<number>((n, x) => n + countChanges(x), 0)
    return 1
  }
  return 1
}

/** Value at a dotted path (`returns.equity`, `limits.2028.k401`). */
export function getPath(v: Json, path: string): unknown {
  let cur: unknown = v
  for (const seg of path.split(".")) {
    if (!isObj(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

/** `v` with the value at a dotted path replaced (objects created on the way). */
export function setPath<T>(v: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".")
  const o: Obj = isObj(v) ? { ...v } : {}
  o[head] = rest.length ? setPath(o[head], rest.join("."), value) : value
  return o as T
}

/** Like countChanges, but against the base the patch applies to: a list item
 * the base does not have counts once, however many fields it carries. */
export function countChangesOver(base: Json, patch: Json): number {
  if (isObj(patch) && isObj(base)) {
    return Object.entries(patch).reduce((n, [k, v]) => {
      const b = base[k]
      if (Array.isArray(v) && Array.isArray(b)) {
        const key = listKey(v)
        if (key)
          return (
            n +
            v.reduce<number>((m, item) => {
              const was = b.find(
                (x) => isObj(x) && String(x[key]) === kv(item, key)
              )
              if (was === undefined || (item as Obj)[REMOVE] === true)
                return m + 1
              return m + countChangesOver(was, item)
            }, 0)
          )
        return n + 1
      }
      if (isObj(v) && isObj(b)) return n + countChangesOver(b, v)
      return n + (k === "id" || k === "from" ? 0 : 1)
    }, 0)
  }
  return countChanges(patch)
}
