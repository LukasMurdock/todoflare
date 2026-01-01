"use client";

import * as React from "react";

import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { PlateElement } from "platejs/react";

export function LinkElement(props: PlateElementProps<TLinkElement>) {
	const url = props.element.url;

	return (
		<PlateElement
			{...props}
			as="a"
			className="font-medium text-primary underline decoration-primary underline-offset-4"
			attributes={{
				...props.attributes,
				href: url,
				target: "_blank",
				rel: "noopener noreferrer",
				onMouseOver: (e: React.MouseEvent) => {
					e.stopPropagation();
				},
			}}
		>
			{props.children}
		</PlateElement>
	);
}
