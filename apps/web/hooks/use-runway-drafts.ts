"use client"

// Unsaved /runway edits for every person plus the shared defaults, kept
// above the person view so switching person or scenario never loses them.
// Mirrored to sessionStorage (best effort) so a reload keeps them too.
//
// When fresh data arrives (after a save, or a refetch), a person whose draft
// is clean starts over from it. A dirty draft keeps its edits on top of the
// new saved copy and is flagged stale when the files changed underneath.

import * as React from "react"

import {
  applySharedTo,
  draftFrom,
  isDirty,
  isSharedDirty,
  type PersonDraft,
  type SharedDraft,
} from "@/lib/runway/drafts"
import type {
  PersonRecord,
  RunwayData,
  SharedSettings,
} from "@/lib/runway/types"

const KEY = "runway.drafts.v1"

interface Stored {
  version: string
  people: Record<string, Pick<PersonDraft, "plan" | "scenarios" | "overrides">>
  shared: SharedSettings | null
}

function readStored(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Stored) : null
  } catch {
    return null
  }
}

function writeStored(s: Stored | null) {
  try {
    if (s) window.sessionStorage.setItem(KEY, JSON.stringify(s))
    else window.sessionStorage.removeItem(KEY)
  } catch {
    // Private mode or storage blocked: drafts still live in memory.
  }
}

interface State {
  version: string
  people: Record<string, PersonDraft>
  shared: SharedDraft
  /** Person ids whose draft was restored from sessionStorage. */
  restored: string[]
  /** Person ids whose dirty draft predates the current files. */
  stale: string[]
}

function init(data: RunwayData): State {
  const stored = typeof window === "undefined" ? null : readStored()
  const usable = stored && stored.version === data.version ? stored : null
  const shared: SharedDraft = {
    saved: data.shared,
    edited: usable?.shared ?? data.shared,
  }
  const people: Record<string, PersonDraft> = {}
  const restored: string[] = []
  for (const r of data.people) {
    let d = draftFrom(r)
    const s = usable?.people[r.id]
    if (s) {
      d = { ...d, ...s }
      restored.push(r.id)
    }
    people[r.id] = applySharedTo(d, shared.edited)
  }
  return { version: data.version, people, shared, restored, stale: [] }
}

/** Fold fresh data into the drafts. `reset` names people (and "shared")
 * that just saved and so start over regardless. */
function rebase(prev: State, data: RunwayData, reset: Set<string>): State {
  const changed = data.version !== prev.version
  const sharedReset = reset.has("shared") || !isSharedDirty(prev.shared)
  const shared: SharedDraft = sharedReset
    ? { saved: data.shared, edited: data.shared }
    : { saved: data.shared, edited: prev.shared.edited }
  const people: Record<string, PersonDraft> = {}
  const stale = new Set(prev.stale)
  for (const r of data.people) {
    const old = prev.people[r.id]
    if (!old || reset.has(r.id) || !isDirty(old)) {
      people[r.id] = applySharedTo(draftFrom(r), shared.edited)
      stale.delete(r.id)
    } else {
      people[r.id] = applySharedTo(
        {
          saved: r,
          plan: old.plan,
          scenarios: old.scenarios,
          overrides: old.overrides,
        },
        shared.edited
      )
      if (changed) stale.add(r.id)
    }
  }
  return {
    version: data.version,
    people,
    shared,
    restored: prev.restored.filter((id) => people[id] && isDirty(people[id])),
    stale: [...stale].filter((id) => people[id]),
  }
}

export interface DraftSnapshot {
  personId: string | null
  person: PersonDraft | null
  shared: SharedSettings | null
}

export function useRunwayDrafts(data: RunwayData) {
  const [state, setState] = React.useState<State>(() => init(data))
  const resetNext = React.useRef<Set<string>>(new Set())
  const seen = React.useRef(data)

  React.useEffect(() => {
    if (seen.current === data) return
    seen.current = data
    const reset = resetNext.current
    resetNext.current = new Set()
    setState((prev) => rebase(prev, data, reset))
  }, [data])

  // Mirror dirty drafts to sessionStorage.
  React.useEffect(() => {
    const people: Stored["people"] = {}
    for (const [id, d] of Object.entries(state.people))
      if (isDirty(d))
        people[id] = {
          plan: d.plan,
          scenarios: d.scenarios,
          overrides: d.overrides,
        }
    const shared = isSharedDirty(state.shared) ? state.shared.edited : null
    writeStored(
      Object.keys(people).length || shared
        ? { version: state.version, people, shared }
        : null
    )
  }, [state])

  const update = React.useCallback(
    (id: string, fn: (d: PersonDraft) => PersonDraft) => {
      setState((s) =>
        s.people[id]
          ? { ...s, people: { ...s.people, [id]: fn(s.people[id]) } }
          : s
      )
    },
    []
  )

  const setShared = React.useCallback((next: SharedSettings) => {
    setState((s) => {
      const people: Record<string, PersonDraft> = {}
      for (const [id, d] of Object.entries(s.people))
        people[id] = applySharedTo(d, next)
      return { ...s, people, shared: { ...s.shared, edited: next } }
    })
  }, [])

  /** Throw away one person's edits (and the shared edits); returns what was
   * dropped so Undo can put it back. */
  const discard = React.useCallback(
    (personId: string | null): DraftSnapshot => {
      const snap: DraftSnapshot = {
        personId,
        person: personId ? (state.people[personId] ?? null) : null,
        shared: isSharedDirty(state.shared) ? state.shared.edited : null,
      }
      setState((s) => {
        const shared = { ...s.shared, edited: s.shared.saved }
        const people: Record<string, PersonDraft> = {}
        for (const [id, d] of Object.entries(s.people)) {
          const base = id === personId ? draftFrom(d.saved) : d
          people[id] = applySharedTo(base, shared.edited)
        }
        return {
          ...s,
          people,
          shared,
          restored: s.restored.filter((x) => x !== personId),
          stale: s.stale.filter((x) => x !== personId),
        }
      })
      return snap
    },
    [state]
  )

  const restore = React.useCallback((snap: DraftSnapshot) => {
    setState((s) => {
      const sharedEdited = snap.shared ?? s.shared.edited
      const people: Record<string, PersonDraft> = {}
      for (const [id, d] of Object.entries(s.people)) {
        const base = id === snap.personId && snap.person ? snap.person : d
        people[id] = applySharedTo(base, sharedEdited)
      }
      return { ...s, people, shared: { ...s.shared, edited: sharedEdited } }
    })
  }, [])

  /** The next data load comes from our own save: start these over. */
  const expectReset = React.useCallback((ids: string[]) => {
    for (const id of ids) resetNext.current.add(id)
  }, [])

  const record = (id: string): PersonRecord | undefined =>
    state.people[id]?.saved

  return {
    people: state.people,
    shared: state.shared,
    restored: state.restored,
    stale: state.stale,
    update,
    setShared,
    discard,
    restore,
    expectReset,
    record,
  }
}

export type RunwayDrafts = ReturnType<typeof useRunwayDrafts>
