import type { ComponentProps } from "react"
import { Arrow as TooltipArrowPrimitive, Content as TooltipContentPrimitive, Portal as TooltipPortalPrimitive, Provider as TooltipProviderPrimitive, Root as TooltipRootPrimitive, Trigger as TooltipTriggerPrimitive } from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"
import { usePortalContainer } from "@todoflare/board";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: ComponentProps<typeof TooltipProviderPrimitive>) {
  return (
    <TooltipProviderPrimitive
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: ComponentProps<typeof TooltipRootPrimitive>) {
  return (
    <TooltipProvider>
      <TooltipRootPrimitive data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: ComponentProps<typeof TooltipTriggerPrimitive>) {
  return <TooltipTriggerPrimitive data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipContentPrimitive>) {
  return (
    <TooltipPortalPrimitive container={usePortalContainer()}>
      <TooltipContentPrimitive
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground border border-border/70 shadow-pop dark:ring-1 dark:ring-white/[0.06] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-lg px-2.5 py-1.5 text-xs leading-4 text-balance",
          className
        )}
        {...props}
      >
        {children}
        <TooltipArrowPrimitive className="fill-popover z-50 -mt-px h-1.5 w-3 drop-shadow-[0_1px_0_var(--border)]" />
      </TooltipContentPrimitive>
    </TooltipPortalPrimitive>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
