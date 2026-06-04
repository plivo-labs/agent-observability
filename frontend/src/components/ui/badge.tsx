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
        destructive: "border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-accent",
        /** Outline ghost — paper bg, ink border. */
        outline: "border-foreground bg-background text-foreground [a&]:hover:bg-foreground [a&]:hover:text-background",
        ghost: "border-transparent text-tertiary [a&]:hover:text-foreground",
        link: "border-transparent text-foreground underline-offset-4 [a&]:hover:underline [a&]:hover:text-accent",
        /** Semantic duos — `(soft bg + base fg + soft border)`. */
        ok: "border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg))]",
        warn: "border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg))]",
        err: "border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))]",
        info: "border-[hsl(var(--info-border))] bg-[hsl(var(--info-bg))] text-[hsl(var(--info))]",
        agent: "border-[hsl(var(--accent-purple-border))] bg-[hsl(var(--accent-purple-bg))] text-[hsl(var(--accent-purple))]",
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
