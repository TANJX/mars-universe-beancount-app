// The app's navigation model. Single source of truth for page order,
// grouping, labels, icons and `g`-leader keys: the sidebar rail and panel,
// the mobile switcher, the ⌘K palette, GlobalKeys and the shortcuts dialog
// all read from here.
//
// Sections group pages by the question they answer, ordered
// present > past > future; Planning runs from weeks to decades.
import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarClock,
  Compass,
  Flame,
  Home,
  LayoutGrid,
  ListTree,
  PieChart,
  Receipt,
  Wallet,
  Waypoints,
} from "lucide-react"
import type * as React from "react"

export type NavIcon = React.ComponentType<{
  className?: string
  size?: number
  strokeWidth?: number
}>

export interface NavPage {
  href: string
  label: string
  icon: NavIcon
  /** One line under the label in the panel and the mobile switcher. */
  hint: string
  /** Letter that follows the `g` leader (see GlobalKeys). */
  leaderKey: string
}

export interface NavSection {
  id: "home" | "accounts" | "activity" | "planning"
  label: string
  icon: NavIcon
  pages: NavPage[]
}

const overview: NavPage = {
  href: "/overview",
  label: "Overview",
  icon: LayoutGrid,
  hint: "Net worth, this period, recent",
  leaderKey: "o",
}
const balances: NavPage = {
  href: "/balances",
  label: "Balances",
  icon: ListTree,
  hint: "Every account, today",
  leaderKey: "b",
}
const portfolio: NavPage = {
  href: "/portfolio",
  label: "Portfolio",
  icon: PieChart,
  hint: "Holdings and allocation",
  // `p` belongs to Plan; Portfolio takes the next letter in its name.
  leaderKey: "f",
}
const income: NavPage = {
  href: "/income",
  label: "Income",
  icon: BarChart3,
  hint: "Pay, interest, refunds",
  leaderKey: "i",
}
const expenses: NavPage = {
  href: "/expenses",
  label: "Expenses",
  icon: Receipt,
  hint: "Where the money went",
  leaderKey: "e",
}
const journal: NavPage = {
  href: "/journal",
  label: "Journal",
  icon: BookOpen,
  hint: "Every transaction",
  leaderKey: "j",
}
const plan: NavPage = {
  href: "/plan",
  label: "Plan",
  icon: CalendarClock,
  hint: "Card payments and transfers",
  leaderKey: "p",
}
const runway: NavPage = {
  href: "/runway",
  label: "Runway",
  icon: Waypoints,
  hint: "The next 24 months",
  // `r` belongs to FIRE; Runway takes the next letter in its name.
  leaderKey: "u",
}
const fire: NavPage = {
  href: "/fire",
  label: "FIRE",
  icon: Flame,
  hint: "Decades out",
  // `f` belongs to Portfolio; FIRE takes the next letter in its name.
  leaderKey: "r",
}

export const NAV_SECTIONS: NavSection[] = [
  { id: "home", label: "Home", icon: Home, pages: [overview] },
  {
    id: "accounts",
    label: "Accounts",
    icon: Wallet,
    pages: [balances, portfolio],
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    pages: [income, expenses, journal],
  },
  {
    id: "planning",
    label: "Planning",
    icon: Compass,
    pages: [plan, runway, fire],
  },
]

/** Every page in nav order. */
export const NAV_PAGES: NavPage[] = NAV_SECTIONS.flatMap((s) => s.pages)

export function isPageActive(pathname: string, href: string): boolean {
  // An account detail page belongs to Balances.
  if (href === "/balances" && pathname.startsWith("/account/")) return true
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function sectionFor(pathname: string): NavSection {
  return (
    NAV_SECTIONS.find((s) =>
      s.pages.some((p) => isPageActive(pathname, p.href))
    ) ?? NAV_SECTIONS[0]
  )
}

export function pageFor(pathname: string): NavPage | undefined {
  return NAV_PAGES.find((p) => isPageActive(pathname, p.href))
}
