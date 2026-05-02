"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { z } from "zod"

import { favaFetch } from "@/lib/fava/client"

const ChangedSchema = z.boolean()

const DEFAULT_INTERVAL_MS = 5000

/**
 * Mirror fava's file-watch + auto-reload pipeline.
 *
 * Polls `/api/changed` on an interval; when the backend reports a
 * ledger file change, invalidate the entire React Query cache so all
 * mounted pages re-fetch from fava with the new mtime.
 *
 * Pauses while the document is hidden so background tabs don't keep
 * hitting the API. Recursive setTimeout (not setInterval) prevents
 * overlapping in-flight requests if a poll takes longer than the
 * interval — important when network is slow or the dev server stalls.
 */
export function useChangedPoll(intervalMs: number = DEFAULT_INTERVAL_MS) {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function tick() {
      if (stopped) return
      if (!document.hidden) {
        try {
          const res = await favaFetch("changed", ChangedSchema)
          if (res.data === true) {
            await queryClient.invalidateQueries()
          }
        } catch {
          // Network blip or fava restart — swallow and try again.
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }

    timer = setTimeout(tick, intervalMs)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs, queryClient])
}
