'use client';


import { isOrderedList } from '@platejs/list';
import {
  useTodoListElement,
  useTodoListElementState,
} from '@platejs/list/react';
import { useReadOnly } from 'platejs/react';
import type { PlateElementProps, RenderNodeWrapper } from 'platejs/react';

import { Checkbox } from './checkbox';
import { cn } from './cn';

export const BlockList: RenderNodeWrapper = (props) => {
  if (!props.element.listStyleType) {return;}

  return List;
};

function List(props: PlateElementProps) {
  const listStart = typeof props.element.listStart === 'number' ? props.element.listStart : undefined;
  const listStyleType = typeof props.element.listStyleType === 'string' ? props.element.listStyleType : undefined;
  const todo = listStyleType === 'todo';
  const List = isOrderedList(props.element) ? 'ol' : 'ul';

  return (
    <List
      className="relative m-0 p-0 tabular-nums marker:text-muted-foreground/70"
      style={{ listStyleType }}
      start={listStart}
    >
      {todo && <TodoMarker {...props} />}
      {todo ? <TodoLi {...props} /> : <li>{props.children}</li>}
    </List>
  );
}

function TodoMarker(props: PlateElementProps) {
  const state: unknown = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();

  return (
    <div contentEditable={false}>
      <Checkbox
        className={cn(
          '-left-4 absolute top-[calc(0.5lh-0.5rem)]',
          readOnly && 'pointer-events-none'
        )}
        {...checkboxProps}
      />
    </div>
  );
}

function TodoLi(props: PlateElementProps) {
  return (
    <li
      className={cn(
        'list-none pl-2 line-through decoration-[1.5px] transition-[color,text-decoration-color] duration-200 ease-out',
        props.element.checked
          ? 'text-muted-foreground decoration-muted-foreground/60'
          : 'decoration-transparent'
      )}
    >
      {props.children}
    </li>
  );
}
