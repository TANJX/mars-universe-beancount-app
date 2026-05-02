// Bundled-default merchant registry. Universal brands only — anything
// user-specific belongs in the user's `ui.yaml > merchants:` section.
// Keys are the canonical brand `name` (also the lookup id and the seed for
// the auto-derived letter-mark fallback). Per-entry fields:
//   - `domain`  — handed to logo.dev for image fetching. Omit for niche or
//                 non-public brands; the avatar falls back to a colored letter.
//   - `aliases` — extra payee tokens (case-insensitive) that should also
//                 resolve to this merchant (ACH wire tokens, abbreviations,
//                 alternate spellings). Used by stages 3 + 4 of the resolver.

import type { MerchantEntry } from "../types"

export const MERCHANT_DEFAULTS: MerchantEntry[] = [
  // ── Transport ───────────────────────────────────────────────────────────
  { name: "Tesla", domain: "tesla.com" },
  { name: "Uber", domain: "uber.com" },
  { name: "Lyft", domain: "lyft.com" },
  { name: "NJ Transit", domain: "njtransit.com" },
  { name: "MTA", domain: "mta.info" },
  { name: "JR East", domain: "jreast.co.jp" },
  { name: "Suica" },
  { name: "Delta", domain: "delta.com" },
  { name: "American Airlines", domain: "aa.com" },
  { name: "Cathay Pacific", domain: "cathaypacific.com" },
  { name: "Alaska Airlines", domain: "alaskaair.com" },

  // ── Food + restaurants ──────────────────────────────────────────────────
  { name: "Costco", domain: "costco.com" },
  { name: "Whole Foods", domain: "wholefoodsmarket.com" },
  { name: "Trader Joe", domain: "traderjoes.com" },
  { name: "Starbucks", domain: "starbucks.com" },
  { name: "Blue Bottle Coffee", domain: "bluebottlecoffee.com" },
  { name: "Doordash", domain: "doordash.com" },
  { name: "Grubhub", domain: "grubhub.com" },

  // ── Subscriptions + entertainment ───────────────────────────────────────
  { name: "Netflix", domain: "netflix.com" },
  { name: "Spotify", domain: "spotify.com" },
  { name: "YouTube", domain: "youtube.com" },
  { name: "Apple", domain: "apple.com" },
  { name: "Google", domain: "google.com" },
  { name: "Microsoft", domain: "microsoft.com" },
  { name: "Adobe", domain: "adobe.com" },

  // ── Banks + brokerages ──────────────────────────────────────────────────
  { name: "Robinhood", domain: "robinhood.com" },
  { name: "Chase", domain: "chase.com" },
  { name: "Bank of America", domain: "bankofamerica.com" },
  { name: "Discover", domain: "discover.com" },
  { name: "Citi", domain: "citi.com" },
  { name: "Wells Fargo", domain: "wellsfargo.com" },
  { name: "Coinbase", domain: "coinbase.com" },
  { name: "Webull", domain: "webull.com" },
  { name: "American Express", domain: "americanexpress.com" },
  { name: "Bilt", domain: "biltrewards.com" },

  // ── Utilities + housing ─────────────────────────────────────────────────
  {
    name: "Con Edison",
    domain: "coned.com",
    aliases: ["consolidated edison", "coned"],
  },
  {
    name: "Verizon",
    domain: "verizon.com",
    aliases: ["verizon wireless"],
  },
  { name: "T-Mobile", domain: "t-mobile.com", aliases: ["tmobile"] },
  { name: "Optum", domain: "optum.com" },
  { name: "CVS", domain: "cvs.com" },
  { name: "PSEG", domain: "pseg.com", aliases: ["public service"] },

  // ── Misc ────────────────────────────────────────────────────────────────
  { name: "Amazon", domain: "amazon.com" },
  { name: "Stripe", domain: "stripe.com" },
  { name: "Alipay", domain: "alipay.com" },
  {
    name: "Ticketmaster",
    domain: "ticketmaster.com",
    // Stage-3 pattern strips `Tm *` and resolves to this name directly.
  },

  // ── Rails / generic providers ───────────────────────────────────────────
  { name: "Zelle", domain: "zellepay.com" },
  { name: "PayPal", domain: "paypal.com" },
  { name: "Venmo", domain: "venmo.com" },
]
