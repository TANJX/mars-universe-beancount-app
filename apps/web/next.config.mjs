// Fava host: localhost in dev, `http://fava:5000` in Compose (set via env).
const FAVA_INTERNAL_URL =
  process.env.FAVA_INTERNAL_URL ?? "http://127.0.0.1:5000"

// Fava slugifies the journal title and uses it as the URL prefix. Coordinate
// this value with the journal's `option "title"` in the deployed ledger.
// Local-dev default `mars-universe-bank` matches the personal ledger title.
const FAVA_LEDGER_SLUG =
  process.env.FAVA_LEDGER_SLUG ?? "mars-universe-bank"

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/fava/:path*",
        destination: `${FAVA_INTERNAL_URL}/${FAVA_LEDGER_SLUG}/api/:path*`,
      },
      {
        source: "/api/ext/:path*",
        destination: `${FAVA_INTERNAL_URL}/${FAVA_LEDGER_SLUG}/extension/LedgerDataApi/:path*`,
      },
    ]
  },
}

export default nextConfig
