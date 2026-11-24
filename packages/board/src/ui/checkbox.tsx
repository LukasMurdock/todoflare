import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"

import { cn } from "./cn"

// Transitions only, no mount keyframes: a page load or the static snapshot's
// swap for the live editor renders checked boxes already drawn.
// The box: a crisp hairline that fills with ink, squashing under a press and
// springing back on release.
const checkboxClassName = cn(
  "peer relative grid size-4 shrink-0 place-items-center rounded-[4px] border border-foreground/35 bg-transparent text-primary-foreground outline-none",
  "transition-[background-color,border-color,transform,box-shadow] duration-200 ease-spring",
  "hover:border-foreground/55 active:scale-[0.86] active:duration-75",
  "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  "disabled:cursor-not-allowed disabled:opacity-50"
)

const checkmarkClassName = cn(
  "size-3 [stroke-dasharray:1] [stroke-dashoffset:1.01] transition-[stroke-dashoffset] duration-100 ease-out",
  "group-data-[state=checked]/check:[stroke-dashoffset:0] group-data-[state=checked]/check:delay-[40ms] group-data-[state=checked]/check:duration-[220ms]"
)

/**
 * The checkmark, drawn in with a stroke-dash transition when checked and
 * retracted faster on uncheck. The resting offset sits just past the path
 * length so no round cap shows at its start while unchecked.
 */
function Checkmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(checkmarkClassName, className)}
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" pathLength={1} />
    </svg>
  )
}

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn("group/check", checkboxClassName, className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        forceMount
        className="grid place-content-center text-current"
      >
        <Checkmark />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
