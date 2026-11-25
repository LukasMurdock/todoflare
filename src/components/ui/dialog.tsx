import type { ComponentProps } from "react"
import { Close as DialogClosePrimitive, Content as DialogContentPrimitive, Description as DialogDescriptionPrimitive, Overlay as DialogOverlayPrimitive, Portal as DialogPortalPrimitive, Root as DialogRootPrimitive, Title as DialogTitlePrimitive, Trigger as DialogTriggerPrimitive } from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { usePortalContainer } from "@todoflare/board";

function Dialog({
  ...props
}: ComponentProps<typeof DialogRootPrimitive>) {
  return <DialogRootPrimitive data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: ComponentProps<typeof DialogTriggerPrimitive>) {
  return <DialogTriggerPrimitive data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: ComponentProps<typeof DialogPortalPrimitive>) {
  return <DialogPortalPrimitive data-slot="dialog-portal" container={usePortalContainer()} {...props} />
}

function DialogClose({
  ...props
}: ComponentProps<typeof DialogClosePrimitive>) {
  return <DialogClosePrimitive data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogOverlayPrimitive>) {
  return (
    <DialogOverlayPrimitive
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px] dark:bg-black/60",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof DialogContentPrimitive> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogContentPrimitive
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border/70 p-6 shadow-pop duration-200 ease-out outline-none dark:ring-1 dark:ring-white/[0.06] sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClosePrimitive
            data-slot="dialog-close"
            className="text-muted-foreground absolute top-3.5 right-3.5 inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogClosePrimitive>
        )}
      </DialogContentPrimitive>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogTitlePrimitive>) {
  return (
    <DialogTitlePrimitive
      data-slot="dialog-title"
      className={cn("text-[17px] leading-6 font-semibold tracking-[-0.01em]", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogDescriptionPrimitive>) {
  return (
    <DialogDescriptionPrimitive
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-[13px] leading-5", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
