'use client';

import type { PlateElementProps } from 'platejs/react';

import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { PlateElement } from 'platejs/react';

// Editorial scale for a 320px column: tight tracking on the large sizes,
// fixed line-heights so rhythm holds. Live and static must stay identical.
const headingVariants = cva('relative', {
  variants: {
    variant: {
      h1: 'mt-6 mb-2 font-bold font-heading text-[26px]/[32px] tracking-[-0.03em] [&:first-child]:mt-2',
      h2: 'mt-6 mb-1 font-heading font-semibold text-[19px]/[26px] tracking-[-0.02em]',
      h3: 'mt-5 mb-0.5 font-heading font-semibold text-base/6 tracking-[-0.01em]',
      h4: 'mt-4 font-semibold text-sm/[22px]',
      h5: 'mt-4 font-semibold text-[13px]/5 text-muted-foreground',
      h6: 'mt-4 font-semibold text-[13px]/5 text-muted-foreground',
    },
  },
});

export function HeadingElement({
  variant = 'h1',
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement
      as={variant ?? 'h1'}
      className={headingVariants({ variant })}
      {...props}
    >
      {props.children}
    </PlateElement>
  );
}

export function H1Element(props: PlateElementProps) {
  return <HeadingElement variant="h1" {...props} />;
}

export function H2Element(props: PlateElementProps) {
  return <HeadingElement variant="h2" {...props} />;
}

export function H3Element(props: PlateElementProps) {
  return <HeadingElement variant="h3" {...props} />;
}

export function H4Element(props: PlateElementProps) {
  return <HeadingElement variant="h4" {...props} />;
}

export function H5Element(props: PlateElementProps) {
  return <HeadingElement variant="h5" {...props} />;
}

export function H6Element(props: PlateElementProps) {
  return <HeadingElement variant="h6" {...props} />;
}
