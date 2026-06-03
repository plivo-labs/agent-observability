import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Plivo CX "Neo" Button. All colors reference CSS tokens so consumers who
 * install this component in their own workspace get their theme's values
 * automatically — do not hardcode hex/rgb anywhere.
 *
 * Defaults tuned to Neo: 32px height, 8px radius (`rounded-none`),
 * `text-s-500` type, solid `--primary` surface on the default variant.
 */
/**
 * Instrument Panel button. Square corners (radius 0), mono-uppercase
 * labels with `tracking-section` letter-spacing on default/sm/lg sizes,
 * hairline borders, hover-invert for outline/dashed. The brand red
 * `--accent` is reserved as a "verb" — used only on the primary hover
 * state and destructive variant.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-none font-medium whitespace-nowrap transition-[background,color,border-color,transform] duration-150 outline-none focus-visible:ring-1 focus-visible:ring-foreground/40 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]",
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background border border-foreground hover:bg-accent hover:border-accent",
        destructive:
          "bg-accent text-accent-foreground border border-accent hover:bg-foreground hover:border-foreground",
        outline:
          "border border-foreground bg-background text-foreground hover:bg-foreground hover:text-background [&_svg]:text-tertiary hover:[&_svg]:text-background",
        /** Dashed-border filter pill — becomes solid when filter is applied. */
        dashed:
          "border border-dashed border-border bg-card text-tertiary hover:bg-muted hover:text-foreground hover:border-foreground [&_svg]:text-tertiary hover:[&_svg]:text-foreground",
        secondary:
          "bg-card text-foreground border border-border hover:bg-muted",
        ghost:
          "text-tertiary border border-transparent hover:bg-muted hover:text-foreground",
        link:
          "text-foreground underline-offset-4 hover:underline hover:text-accent",
      },
      size: {
        /** 32px tall — mono-uppercase tracked label. */
        default:
          "h-8 px-3 text-[11px] font-semibold uppercase tracking-section font-mono",
        xs:
          "h-6 gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider font-mono [&_svg:not([class*='size-'])]:size-3",
        sm:
          "h-7 gap-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide font-mono [&_svg:not([class*='size-'])]:size-[12px]",
        lg:
          "h-10 px-5 text-[12px] font-semibold uppercase tracking-section font-mono",
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
