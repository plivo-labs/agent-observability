import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Plivo CX "Neo" Input. Tokens via `border-input` / `bg-background` /
 * `text-foreground` so consumers' themes flow through; Neo defaults are
 * 32px tall, 8px radius, `text-s-400` body.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-s-400 text-foreground outline-none transition-colors",
        "placeholder:text-tertiary",
        "focus-visible:border-secondary/50 focus-visible:ring-2 focus-visible:ring-ring/20",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-xs-500 file:font-medium file:text-foreground",
        "selection:bg-primary selection:text-primary-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input }
