"use client";

import * as React from "react";
import {
	DndContext,
	closestCenter,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	horizontalListSortingStrategy,
} from "@dnd-kit/sortable";

import { useColumns } from "@/hooks/useColumns";
import { ColumnLayout } from "./ColumnLayout";

export function TodoApp() {
	const { columns, addColumn, removeColumn, updateColumnValue, reorderColumns } =
		useColumns();

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 8,
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		})
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;

		if (over && active.id !== over.id) {
			reorderColumns(active.id as string, over.id as string);
		}
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={handleDragEnd}
		>
			<SortableContext
				items={columns.map((c) => c.id)}
				strategy={horizontalListSortingStrategy}
			>
				<ColumnLayout
					columns={columns}
					onAdd={addColumn}
					onUpdate={updateColumnValue}
					onRemove={removeColumn}
				/>
			</SortableContext>
		</DndContext>
	);
}
