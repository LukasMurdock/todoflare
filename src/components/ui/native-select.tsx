import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A real <select>, styled. It stays native so the platform picker, keyboard
 * behavior and accessible role (combobox) are the browser's own.
 */
function NativeSelect({
  className,
  wrapperClassName,
  dot,
  children,
  ...props
}: React.ComponentProps<"select"> & {
  wrapperClassName?: string
  /** A leading status dot; its classes set the color, e.g. "bg-brand". */
  dot?: string | false
}) {
  return (
    <span
      data-slot="native-select"
      className={cn("relative inline-flex shrink-0 items-center", wrapperClassName)}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute left-2.5 size-1.5 rounded-full", dot)}
        />
      ) : null}
      <select
        className={cn(
          "h-8 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-muted/40 pr-7 pl-2.5 text-[13px] font-medium text-foreground transition-colors outline-none hover:bg-muted/80 focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          dot && "pl-6",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDown
        aria-hidden
        className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground"
      />
    </span>
  )
}

export { NativeSelect }
