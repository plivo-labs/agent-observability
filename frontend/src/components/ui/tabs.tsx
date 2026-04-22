import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=vertical]:flex-row data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

/**
 * Plivo CX "Neo" Tabs. Default is the underlined-tab pattern used
 * throughout the observability dashboard (flat list, bottom border, active
 * trigger gets a 2px primary underline). Opt into the pill variant
 * ("pill") when you want the boxed shadcn style.
 *
 * All colors reference `--primary` / `--secondary` / `--border` / etc. so
 * consumers' tokens override automatically.
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default:
          "gap-[2px] border-b border-border bg-transparent rounded-none p-0 h-auto w-full justify-start",
        pill:
          "justify-center rounded-lg bg-bg2 p-[3px] h-8 gap-1 text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // Default (underline) — Neo
        "group-data-[variant=default]/tabs-list:relative group-data-[variant=default]/tabs-list:inline-flex group-data-[variant=default]/tabs-list:items-center group-data-[variant=default]/tabs-list:gap-[7px] group-data-[variant=default]/tabs-list:px-[14px] group-data-[variant=default]/tabs-list:py-[9px] group-data-[variant=default]/tabs-list:text-s-500 group-data-[variant=default]/tabs-list:text-secondary group-data-[variant=default]/tabs-list:border-b-2 group-data-[variant=default]/tabs-list:border-transparent group-data-[variant=default]/tabs-list:-mb-px group-data-[variant=default]/tabs-list:bg-transparent group-data-[variant=default]/tabs-list:rounded-none group-data-[variant=default]/tabs-list:transition-colors group-data-[variant=default]/tabs-list:hover:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:border-primary group-data-[variant=default]/tabs-list:data-[state=active]:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:font-semibold",

        // Pill variant (opt-in) — keeps the old boxed shadcn look.
        "group-data-[variant=pill]/tabs-list:relative group-data-[variant=pill]/tabs-list:inline-flex group-data-[variant=pill]/tabs-list:h-[calc(100%-1px)] group-data-[variant=pill]/tabs-list:flex-1 group-data-[variant=pill]/tabs-list:items-center group-data-[variant=pill]/tabs-list:justify-center group-data-[variant=pill]/tabs-list:gap-1.5 group-data-[variant=pill]/tabs-list:rounded-md group-data-[variant=pill]/tabs-list:border group-data-[variant=pill]/tabs-list:border-transparent group-data-[variant=pill]/tabs-list:px-3 group-data-[variant=pill]/tabs-list:text-s-500 group-data-[variant=pill]/tabs-list:text-secondary group-data-[variant=pill]/tabs-list:hover:text-foreground group-data-[variant=pill]/tabs-list:data-[state=active]:bg-background group-data-[variant=pill]/tabs-list:data-[state=active]:text-foreground group-data-[variant=pill]/tabs-list:data-[state=active]:shadow-sm",

        // Shared
        "whitespace-nowrap outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/20",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[14px] [&_svg]:text-tertiary group-data-[variant=default]/tabs-list:data-[state=active]:[&_svg]:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
