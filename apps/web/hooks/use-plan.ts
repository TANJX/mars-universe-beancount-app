"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  type CcOverrideSaveInput,
  deleteCcCard,
  deletePlan,
  deleteTransfer,
  fetchCcCards,
  fetchPlanGrid,
  fetchPlanSettings,
  type PlanWriteInput,
  saveCcCard,
  saveCcOverride,
  savePlan,
  savePlanSettings,
  saveTransfer,
  type TransferWriteInput,
} from "@/lib/plan/api"
import type { CCCardRecord, PlanSettings } from "@/lib/plan/schemas"

export function usePlanGrid(params: { start?: string; end?: string } = {}) {
  return useQuery({
    queryKey: ["plan_grid", params.start ?? null, params.end ?? null],
    queryFn: () => fetchPlanGrid(params),
    staleTime: 30_000,
  })
}

export function useCcCards() {
  return useQuery({
    queryKey: ["cc_cards"],
    queryFn: fetchCcCards,
    staleTime: 30_000,
  })
}

export function usePlanSettings() {
  return useQuery({
    queryKey: ["plan_settings"],
    queryFn: fetchPlanSettings,
    staleTime: 60_000,
  })
}

export function useSavePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (plan: PlanWriteInput) => savePlan(plan),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan_grid"] }),
  })
}

export function useDeletePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deletePlan(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan_grid"] }),
  })
}

export function useSaveCcCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (record: CCCardRecord) => saveCcCard(record),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cc_cards"] })
      qc.invalidateQueries({ queryKey: ["plan_grid"] })
    },
  })
}

export function useDeleteCcCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accountPath: string) => deleteCcCard(accountPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cc_cards"] })
      qc.invalidateQueries({ queryKey: ["plan_grid"] })
    },
  })
}

export function useSaveTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (transfer: TransferWriteInput) => saveTransfer(transfer),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan_grid"] }),
  })
}

export function useDeleteTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteTransfer(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan_grid"] }),
  })
}

export function useSaveCcOverride() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CcOverrideSaveInput) => saveCcOverride(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plan_grid"] })
    },
  })
}

export function useSavePlanSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings: PlanSettings) => savePlanSettings(settings),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ["plan_settings"] })
      const previous = qc.getQueryData<PlanSettings>(["plan_settings"])
      qc.setQueryData(["plan_settings"], next)
      return { previous }
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(["plan_settings"], ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["plan_settings"] })
      qc.invalidateQueries({ queryKey: ["plan_grid"] })
    },
  })
}
