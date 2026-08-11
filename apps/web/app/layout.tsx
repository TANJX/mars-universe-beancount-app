import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { Providers } from "@/app/providers"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

// SSR can't read the per-request `/ui-config` payload, so the page-title
// metadata bakes a build-time env var. Coordinate with the deployer's
// `branding.title` in `<LEDGER_DIR>/config/ui.yaml`.
// `||`, not `??`: the docker build arg defaults to an empty string, which Next
// inlines as "" — that has to fall back too, not just an unset var.
const APP_TITLE = process.env.NEXT_PUBLIC_APP_TITLE || "Ledger"

export const metadata: Metadata = {
  title: {
    template: `%s · ${APP_TITLE}`,
    default: APP_TITLE,
  },
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable
      )}
    >
      <body>
        <ThemeProvider>
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
