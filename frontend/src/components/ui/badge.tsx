import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Instrument Panel badge. Two-pixel "stamped" radius, mono-uppercase
 * label with `tracking-wide` letter-spacing, hairline border. Status
 * variants use the system's semantic duos (soft bg + base fg + matching
 * border) — pick one of `ok`, `warn`, `err`, `info`, `agent`, `neutral`.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border whitespace-nowrap rounded-xs px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide font-mono transition-colors focus-visible:ring-1 focus-visible:ring-foreground/40 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        /** Filled ink — used for inverted "active count" markers. */
        default: "border-foreground bg-foreground text-background [a&]:hover:bg-accent [a&]:hover:border-accent",
        /** Soft on paper — the most common chip on the dashboard. */
        secondary: "border-border bg-muted text-tertiary [a&]:hover:text-foreground",
        /** Brand red — reserved as a verb (errors, hot states). */
        destructive: "border-destructive-border bg-destructive-bg text-destructive",
        /** Outline ghost — paper bg, ink border. */
        outline: "border-foreground bg-background text-foreground [a&]:hover:bg-foreground [a&]:hover:text-background",
        ghost: "border-transparent text-tertiary [a&]:hover:text-foreground",
        link: "border-transparent text-foreground underline-offset-4 [a&]:hover:underline [a&]:hover:text-ink-2",
        /** Semantic duos — `(soft bg + base fg + soft border)`. */
        ok: "border-success-border bg-success-bg text-success-fg",
        warn: "border-warning-border bg-warning-bg text-warning-fg",
        err: "border-destructive-border bg-destructive-bg text-destructive",
        info: "border-info-border bg-info-bg text-info",
        agent: "border-accent-purple-border bg-accent-purple-bg text-accent-purple",
        neutral: "border-border bg-muted text-tertiary",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  }
)

function Badge({
  className,
  variant = "secondary",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
