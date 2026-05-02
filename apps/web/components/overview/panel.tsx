import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface PanelProps {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

// Thin wrapper on shadcn Card that adds a title bar + optional action slot.
// No rule between header and body — uses spacing, per design-system rules.
export function Panel({
  title,
  action,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  return (
    <Card className={cn("gap-0 overflow-hidden p-0", className)}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="text-xs font-medium tracking-wide text-muted-foreground">
          {title}
        </div>
        {action}
      </div>
      <div className={cn("pb-2", bodyClassName)}>{children}</div>
    </Card>
  )
}
