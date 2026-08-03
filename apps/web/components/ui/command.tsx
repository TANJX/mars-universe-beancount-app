"use client"

import { Command as CommandPrimitive, useCommandState } from "cmdk"
import { CheckIcon, SearchIcon } from "lucide-react"
import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

// Same guard cmdk uses internally — the list-scroll pin below has to run
// before paint on the client without warning during SSR.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

// Keys that move cmdk's selection, and so are the user asking the list to
// follow it. Mirrors cmdk's own keydown handling, vim bindings included.
const NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
])
const VIM_NAV_KEYS = new Set(["n", "p", "j", "k"])

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function CommandList({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const search = useCommandState((state) => state.search)

  // Typing while the list is scrolled used to leave it parked mid-list. cmdk
  // re-scrolls its selected item into view while it is still unmounting and
  // re-sorting items for the new query, so it can land on a stale selection
  // and push the top match off-screen. A one-shot reset loses that race, so
  // hold the list at the top for the whole query and release the moment the
  // user deliberately moves the viewport themselves.
  useIsomorphicLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    let pinned = true
    const release = () => {
      pinned = false
    }
    const snapBack = () => {
      if (pinned && el.scrollTop !== 0) el.scrollTop = 0
    }
    const releaseOnNavKey = (e: KeyboardEvent) => {
      if (NAV_KEYS.has(e.key) || (e.ctrlKey && VIM_NAV_KEYS.has(e.key))) {
        release()
      }
    }
    el.scrollTop = 0
    el.addEventListener("scroll", snapBack)
    el.addEventListener("wheel", release, { passive: true })
    el.addEventListener("touchmove", release, { passive: true })
    // Capture phase: cmdk moves the selection and scrolls it into view from
    // its own keydown handler, so the pin has to be gone before that runs.
    document.addEventListener("keydown", releaseOnNavKey, true)
    return () => {
      el.removeEventListener("scroll", snapBack)
      el.removeEventListener("wheel", release)
      el.removeEventListener("touchmove", release)
      document.removeEventListener("keydown", releaseOnNavKey, true)
    }
  }, [search])

  return (
    <CommandPrimitive.List
      data-slot="command-list"
      ref={(node) => {
        listRef.current = node
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
      }}
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-foreground",
        className
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}
