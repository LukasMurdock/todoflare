import React from "react"
import { Close as DialogPrimitiveClose, Content as DialogPrimitiveContent, Description as DialogPrimitiveDescription, Overlay as DialogPrimitiveOverlay, Portal as DialogPrimitivePortal, Root as DialogPrimitiveRoot, Title as DialogPrimitiveTitle, Trigger as DialogPrimitiveTrigger } from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "./cn"
import { usePortalContainer } from "../portal-container";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitiveRoot>) {
  return <DialogPrimitiveRoot data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitiveTrigger>) {
  return <DialogPrimitiveTrigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitivePortal>) {
  return <DialogPrimitivePortal data-slot="dialog-portal" container={usePortalContainer()} {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitiveClose>) {
  return <DialogPrimitiveClose data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveOverlay>) {
  return (
    <DialogPrimitiveOverlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] dark:bg-black/60",
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
}: React.ComponentProps<typeof DialogPrimitiveContent> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitiveContent
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-hairline p-6 shadow-pop duration-200 ease-out-quint outline-none sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitiveClose
            data-slot="dialog-close"
            className="ring-offset-background focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-3.5 right-3.5 grid size-7 place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-foreground/[0.06] hover:text-foreground transition-[opacity,background-color,color] hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitiveClose>
        )}
      </DialogPrimitiveContent>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
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
}: React.ComponentProps<typeof DialogPrimitiveTitle>) {
  return (
    <DialogPrimitiveTitle
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveDescription>) {
  return (
    <DialogPrimitiveDescription
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
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
