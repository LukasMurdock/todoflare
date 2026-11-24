import * as React from 'react';

import type { RenderStaticNodeWrapper, TListElement } from 'platejs';
import type { SlateRenderElementProps } from 'platejs/static';

import { isOrderedList } from '@platejs/list';
import { Checkbox } from './checkbox';

import { cn } from './cn';

const config: Record<
  string,
  {
    Li: React.FC<SlateRenderElementProps>;
    Marker: React.FC<SlateRenderElementProps>;
  }
> = {
  todo: {
    Li: TodoLiStatic,
    Marker: TodoMarkerStatic,
  },
};

export const BlockListStatic: RenderStaticNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;

  return (props) => <List {...props} />;
};

function List(props: SlateRenderElementProps) {
  const { listStart, listStyleType } = props.element as TListElement;
  const { Li, Marker } = config[listStyleType] ?? {};
  const List = isOrderedList(props.element) ? 'ol' : 'ul';

  return (
    <List
      className="relative m-0 p-0 tabular-nums marker:text-muted-foreground/70"
      style={{ listStyleType }}
      start={listStart}
    >
      {Marker && <Marker {...props} />}
      {Li ? <Li {...props} /> : <li>{props.children}</li>}
    </List>
  );
}

function TodoMarkerStatic(props: SlateRenderElementProps) {
  // The same checkbox as the live editor's TodoMarker, inert, so a static
  // snapshot is pixel-identical to the editor that replaces it.
  return (
    <div contentEditable={false}>
      <Checkbox
        className="-left-4 absolute top-[calc(0.5lh-0.5rem)] pointer-events-none"
        checked={Boolean(props.element.checked)}
        tabIndex={-1}
        aria-hidden
      />
    </div>
  );
}

function TodoLiStatic(props: SlateRenderElementProps) {
  return (
    <li
      className={cn(
        'list-none pl-2 line-through decoration-[1.5px] transition-[color,text-decoration-color] duration-200 ease-out',
        (props.element.checked as boolean)
          ? 'text-muted-foreground decoration-muted-foreground/60'
          : 'decoration-transparent'
      )}
    >
      {props.children}
    </li>
  );
}
