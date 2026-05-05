"use client"

import * as React from "react"
import Image from "next/image"

import { useHydrated } from "@/hooks/use-hydrated"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { logoDevUrl } from "@/lib/merchants/logodev"

const STORAGE_KEY = "demo-welcome-dismissed-v1"

const REPOS = [
  {
    label: "App code",
    sublabel: "TANJX/mars-universe-beancount-app",
    href: "https://github.com/TANJX/mars-universe-beancount-app",
  },
  {
    label: "Demo ledger",
    sublabel: "TANJX/mars-universe-beancount-demo",
    href: "https://github.com/TANJX/mars-universe-beancount-demo",
  },
]

// 20px logo (size=20 → 40px @2x), matches the size-5 box.
const GH_LOGO = logoDevUrl("github.com", 20)

function isDemo(): boolean {
  const v = process.env.NEXT_PUBLIC_DEMO_MODE
  return !!v && v !== "0" && v.toLowerCase() !== "false"
}

function isDismissed(): boolean {
  if (typeof window === "undefined") return false

  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export function DemoWelcome() {
  const hydrated = useHydrated()
  const [dismissed, setDismissed] = React.useState(false)

  function dismiss() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1")
    } catch {
      // ignore — non-fatal
    }
    setDismissed(true)
  }

  if (!isDemo()) return null

  const open = hydrated && !dismissed && !isDismissed()

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to the demo</DialogTitle>
          <DialogDescription>
            A public sandbox of a personal-finance dashboard built on{" "}
            <a
              href="https://beancount.github.io"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Beancount
            </a>
            . All numbers, accounts, and merchants are synthetic — generated to
            exercise the UI. Source code and the demo ledger are public.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {REPOS.map((r) => (
            <a
              key={r.href}
              href={r.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-accent"
            >
              {GH_LOGO ? (
                <Image
                  src={GH_LOGO}
                  alt=""
                  width={20}
                  height={20}
                  unoptimized
                  className="size-5 shrink-0 rounded"
                />
              ) : (
                <span className="size-5 shrink-0 rounded bg-muted" />
              )}
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{r.label}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {r.sublabel}
                </span>
              </div>
            </a>
          ))}
        </div>
        <div className="flex justify-end">
          <Button onClick={dismiss}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
