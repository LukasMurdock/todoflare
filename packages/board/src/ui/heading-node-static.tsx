import React from 'react';

import type { SlateElementProps } from 'platejs/static';

import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { SlateElement } from 'platejs/static';

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

export function HeadingElementStatic({
  variant = 'h1',
  ...props
}: SlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <SlateElement
      as={variant ?? 'h1'}
      className={headingVariants({ variant })}
      {...props}
    >
      {props.children}
    </SlateElement>
  );
}

export function H1ElementStatic(props: SlateElementProps) {
  return <HeadingElementStatic variant="h1" {...props} />;
}

export function H2ElementStatic(
  props: React.ComponentProps<typeof HeadingElementStatic>
) {
  return <HeadingElementStatic variant="h2" {...props} />;
}

export function H3ElementStatic(
  props: React.ComponentProps<typeof HeadingElementStatic>
) {
  return <HeadingElementStatic variant="h3" {...props} />;
}

export function H4ElementStatic(
  props: React.ComponentProps<typeof HeadingElementStatic>
) {
  return <HeadingElementStatic variant="h4" {...props} />;
}

export function H5ElementStatic(
  props: React.ComponentProps<typeof HeadingElementStatic>
) {
  return <HeadingElementStatic variant="h5" {...props} />;
}

export function H6ElementStatic(
  props: React.ComponentProps<typeof HeadingElementStatic>
) {
  return <HeadingElementStatic variant="h6" {...props} />;
}
