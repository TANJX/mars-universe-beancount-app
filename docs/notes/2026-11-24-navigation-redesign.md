# Navigation redesign (2026-11-24)

Decided from a prototype picker (three rounds, since deleted). The nav had
grown to nine pages in the order they were built, copied by hand into four
places (sidebar, ⌘K palette, `g` shortcuts, shortcuts dialog). The mobile tab
bar reached only five of them: Plan, Portfolio, FIRE and Runway, plus
bookmarks, search and settings, were unreachable on a phone.

## Decision

**Information architecture.** Four sections, grouped by the question a page
answers and ordered present > past > future. Planning runs from weeks to
decades.

| Section | Pages |
| --- | --- |
| Home | Overview |
| Accounts | Balances, Portfolio |
| Activity | Income, Expenses, Journal |
| Planning | Plan, Runway, FIRE |

Single source: `apps/web/components/layout/nav.ts`. The sidebar, mobile
switcher, palette (one group per section), GlobalKeys and the shortcuts dialog
all read from it. `g` letters are unchanged.

**Desktop: two-level, card wrapper.**

- Rail (64px) on a tinted canvas: logo (links to Overview), search, the four
  sections, display settings, panel toggle. A section returns to the page last
  used inside it (`mars-nav-last` in localStorage).
- Panel (240px) and page share one raised card (inset 8px, radius 12px),
  divided by a hairline. The panel lists the section's pages with a one-line
  hint, then section context: Home shows upcoming plan items, Accounts shows
  account groups with balances, Activity shows bookmarks with balances plus
  saved searches, and Planning shows upcoming card payments. Plan shows an
  open to-do count, and its section icon shows a dot.
- Flyout: hovering another section (120ms dwell, 220ms close grace) floats
  its panel so any page is one click away. Moving between icons switches
  instantly. Keyboard: → on a section opens it with focus inside, ← or Escape
  returns focus to the rail. Enter is 160ms `cubic-bezier(0.32, 0.72, 0, 1)`;
  exit is an instant unmount; reduced motion fades only.
- ⌘B hides the panel (rail-only); the flyout then becomes the main way around.
- Panel title, rail logo and the Topbar period picker share one 58px centre
  line.

**Mobile: Switcher, no tab bar.** A "Section / Page ▾" breadcrumb opens a
Go-to sheet with every page grouped like the rail, the current section's
context inline, and theme and row settings. Search opens the ⌘K palette.

**Tokens** (`app/globals.css`, "App shell" block):

- canvas light `oklch(0.92 0.04 22)` in sRGB, and `oklch(0.92 0.052 22)` (as
  tuned) behind `@media (color-gamut: p3)`. Chroma 0.052 is out of sRGB at
  this L and hue.
- canvas dark `oklch(0.18 0.04 22)`: the same hue re-picked for the dark
  surface, 0.03 L below the card. Rail text there is `oklch(0.74 0.03 22)`
  (8.1:1).
- `--canvas-muted` `oklch(0.48 0.03 22)` for rail text: 5.2:1 on the canvas.
  The stock muted-foreground is only 3.8:1 there, which fails AA for the 10px
  labels.
- Light shadows are layered stacks; dark collapses them to 1px white rings.
  The flyout uses `--card` in dark because `--popover` is warm against the
  cool card.

## Rejected

- **Flat reorder / grouped single sidebar (Horizon).** The grouping won, but
  as a single list it is just a longer sidebar. The two-level layout reads
  cleaner and leaves room for per-section context.
- **Cadence grouping** (daily / review / long term). Grouping by habit
  instead of meaning put Expenses and Income behind "More" on mobile.
- **Two-level without flyout.** It cost two clicks across sections; the
  flyout and last-page memory bring that back to one.
- **Mobile tab per section + segmented control.** It works, but the
  breadcrumb switcher keeps the full screen height for content and shows
  every page in one sheet.
- **Mobile title-as-H1 switcher.** Pages already draw their own big title, so
  the switcher became a compact breadcrumb.
- **Flat and Canvas wrappers.** Flat gave no boundary to the work area.
  Canvas (panel on the canvas, only the page as card) made the panel read as
  background.
- **Neutral canvas** (`oklch(0.948 0.006 40)` light, `oklch(0.17 0.006 286)`
  dark). Too timid; the rose tint ties the chrome to the brand red in both
  themes.

## Known follow-ups

- Home and Planning panel context come from the plan grid, which is often
  empty ("Nothing scheduled in Plan."). Revisit with the home dashboard
  redesign; headline numbers (runway months, net-worth trend) are candidates.
