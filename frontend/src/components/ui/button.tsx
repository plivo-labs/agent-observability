import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Plivo CX "Neo" Button. All colors reference CSS tokens so consumers who
 * install this component in their own workspace get their theme's values
 * automatically — do not hardcode hex/rgb anywhere.
 *
 * Defaults tuned to Neo: 32px height, 8px radius (`rounded-lg`),
 * `text-s-500` type, solid `--primary` surface on the default variant.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-foreground text-foreground-foreground hover:bg-foreground/90 focus-visible:ring-destructive/20",
        outline:
          "border border-input bg-background text-foreground hover:bg-bg2 hover:border-secondary/40 [&_svg]:text-tertiary hover:[&_svg]:text-secondary",
        /** Dashed-border filter pill used by data-table toolbars. Becomes
         *  solid when something is filtered (the consumer toggles the class
         *  by switching to variant="outline"). */
        dashed:
          "border border-dashed border-input bg-background text-secondary hover:bg-bg2 hover:text-foreground hover:border-secondary/40 [&_svg]:text-tertiary hover:[&_svg]:text-secondary",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/90",
        ghost:
          "text-secondary hover:bg-bg2 hover:text-foreground",
        link:
          "text-link underline-offset-4 hover:underline",
      },
      size: {
        /** 32px tall — the default per Neo. */
        default: "h-8 px-3 text-s-500",
        xs: "h-6 gap-1 px-2 text-xxs-600 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-xs-500 [&_svg:not([class*='size-'])]:size-[12px]",
        lg: "h-10 px-5 text-p-500",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-[13px]",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
