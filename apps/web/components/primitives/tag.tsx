import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Tone = "accent" | "pos" | "neg" | "warn" | "neutral" | "forecast"
type Size = "xs" | "sm"

interface TagProps {
  tone?: Tone
  size?: Size
  className?: string
  children: React.ReactNode
}

// Thin wrapper on shadcn Badge that adds financial-domain tones
// (pos/neg/warn/forecast) that shadcn's variants don't cover.
const TONE_CLASSES: Record<Tone, string> = {
  accent: "bg-primary/10 text-primary border-transparent",
  pos: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-transparent",
  neg: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-transparent",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent",
  neutral: "",
  forecast:
    "bg-transparent border-dashed border-muted-foreground/50 text-muted-foreground",
}

const SIZE_CLASSES: Record<Size, string> = {
  xs: "h-5 text-xs px-1.5",
  sm: "h-5 text-xs px-2",
}

export function Tag({
  tone = "neutral",
  size = "xs",
  className,
  children,
}: TagProps) {
  return (
    <Badge
      variant={tone === "neutral" ? "secondary" : "outline"}
      className={cn(TONE_CLASSES[tone], SIZE_CLASSES[size], className)}
    >
      {children}
    </Badge>
  )
}
