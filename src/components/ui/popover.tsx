import type { ComponentProps } from "react"
import { Anchor as PopoverAnchorPrimitive, Content as PopoverContentPrimitive, Portal as PopoverPortalPrimitive, Root as PopoverRootPrimitive, Trigger as PopoverTriggerPrimitive } from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"
import { usePortalContainer } from "@todoflare/board";

function Popover({
  ...props
}: ComponentProps<typeof PopoverRootPrimitive>) {
  return <PopoverRootPrimitive data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: ComponentProps<typeof PopoverTriggerPrimitive>) {
  return <PopoverTriggerPrimitive data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 6,
  collisionPadding = 12,
  ...props
}: ComponentProps<typeof PopoverContentPrimitive>) {
  return (
    <PopoverPortalPrimitive container={usePortalContainer()}>
      <PopoverContentPrimitive
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-xl border border-border/70 p-3 shadow-pop outline-hidden dark:ring-1 dark:ring-white/[0.06]",
          className
        )}
        {...props}
      />
    </PopoverPortalPrimitive>
  )
}

function PopoverAnchor({
  ...props
}: ComponentProps<typeof PopoverAnchorPrimitive>) {
  return <PopoverAnchorPrimitive data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
