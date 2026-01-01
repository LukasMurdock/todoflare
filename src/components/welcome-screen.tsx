"use client";

import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import { useWelcomeRefs } from "@/contexts/welcome-refs-context";

interface WelcomeScreenProps {
	onDismiss: () => void;
}

interface Position {
	x: number;
	y: number;
}

interface AnnotationConfig {
	key: string;
	label: string;
	// Which side of the target the arrow points to
	arrowTarget: "top" | "bottom" | "left" | "right" | "center";
	// Which direction the label/arrow comes FROM (relative to target)
	arrowFrom: "top" | "bottom" | "left" | "right";
	// Gap between target and label
	gap: number;
	// Optional vertical offset for fine-tuning label position
	labelVerticalOffset?: number;
	// Optional vertical offset for fine-tuning arrow start position
	arrowVerticalOffset?: number;
}

const annotations: AnnotationConfig[] = [
	{
		key: "first-column",
		label: "Start typing to add todos",
		arrowTarget: "right",
		arrowFrom: "right",
		gap: 30,
	},
	{
		key: "add-column-button",
		label: "Add columns",
		arrowTarget: "bottom",
		arrowFrom: "bottom",
		gap: 30,
	},
	{
		key: "shortcuts-button",
		label: "Shortcuts & help",
		arrowTarget: "center",
		arrowFrom: "right",
		gap: 30,
		labelVerticalOffset: -40,
		arrowVerticalOffset: -20,
	},
];

function getTargetPoint(rect: DOMRect, target: AnnotationConfig["arrowTarget"]): Position {
	switch (target) {
		case "top":
			return { x: rect.left + rect.width / 2, y: rect.top };
		case "bottom":
			return { x: rect.left + rect.width / 2, y: rect.bottom };
		case "left":
			return { x: rect.left, y: rect.top + rect.height / 2 };
		case "right":
			return { x: rect.right, y: rect.top + rect.height / 2 };
		case "center":
		default:
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}
}

function CurvedArrow({ from, to }: { from: Position; to: Position }) {
	// Calculate control point for quadratic bezier curve
	const midX = (from.x + to.x) / 2;
	const midY = (from.y + to.y) / 2;
	
	// Offset the control point perpendicular to the line
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	
	if (len === 0) return null;
	
	// Perpendicular offset (curve amount)
	const curveAmount = Math.min(30, len * 0.2);
	const perpX = (-dy / len) * curveAmount;
	const perpY = (dx / len) * curveAmount;
	
	const controlX = midX + perpX;
	const controlY = midY + perpY;
	
	// Arrowhead calculation
	const arrowLength = 8;
	const arrowAngle = Math.PI / 6; // 30 degrees
	
	// Get the tangent angle at the end of the curve
	// For quadratic bezier, tangent at t=1 is direction from control point to end
	const tangentX = to.x - controlX;
	const tangentY = to.y - controlY;
	const tangentAngle = Math.atan2(tangentY, tangentX);
	
	const arrow1X = to.x - arrowLength * Math.cos(tangentAngle - arrowAngle);
	const arrow1Y = to.y - arrowLength * Math.sin(tangentAngle - arrowAngle);
	const arrow2X = to.x - arrowLength * Math.cos(tangentAngle + arrowAngle);
	const arrow2Y = to.y - arrowLength * Math.sin(tangentAngle + arrowAngle);
	
	const pathD = `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
	const arrowD = `M ${arrow1X} ${arrow1Y} L ${to.x} ${to.y} L ${arrow2X} ${arrow2Y}`;
	
	return (
		<g>
			<path
				d={pathD}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
			<path
				d={arrowD}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</g>
	);
}

interface AnnotationProps {
	config: AnnotationConfig;
	targetRect: DOMRect;
}

function Annotation({ config, targetRect }: AnnotationProps) {
	const targetPoint = getTargetPoint(targetRect, config.arrowTarget);
	
	// Calculate label position based on arrowFrom direction
	let labelX: number;
	let labelY: number;
	let arrowStartX: number;
	let arrowStartY: number;
	
	// Estimated label dimensions for positioning
	const labelPadding = 12;
	const estimatedLabelWidth = config.label.length * 7 + labelPadding * 2;
	const estimatedLabelHeight = 28;
	
	// Apply optional vertical offsets
	const labelVerticalOffset = config.labelVerticalOffset ?? 0;
	const arrowVerticalOffset = config.arrowVerticalOffset ?? 0;
	
	switch (config.arrowFrom) {
		case "right":
			// Label is to the right of the target
			labelX = targetPoint.x + config.gap + estimatedLabelWidth / 2;
			labelY = targetPoint.y + labelVerticalOffset;
			arrowStartX = targetPoint.x + config.gap;
			arrowStartY = targetPoint.y + arrowVerticalOffset;
			break;
		case "left":
			// Label is to the left of the target
			labelX = targetPoint.x - config.gap - estimatedLabelWidth / 2;
			labelY = targetPoint.y + labelVerticalOffset;
			arrowStartX = targetPoint.x - config.gap;
			arrowStartY = targetPoint.y + arrowVerticalOffset;
			break;
		case "bottom":
			// Label is below the target
			labelX = targetPoint.x;
			labelY = targetPoint.y + config.gap + estimatedLabelHeight / 2 + labelVerticalOffset;
			arrowStartX = targetPoint.x;
			arrowStartY = targetPoint.y + config.gap + arrowVerticalOffset;
			break;
		case "top":
			// Label is above the target
			labelX = targetPoint.x;
			labelY = targetPoint.y - config.gap - estimatedLabelHeight / 2 + labelVerticalOffset;
			arrowStartX = targetPoint.x;
			arrowStartY = targetPoint.y - config.gap + arrowVerticalOffset;
			break;
	}
	
	return (
		<>
			{/* Label with card background */}
			<g>
				{/* Background rect */}
				<rect
					x={labelX - estimatedLabelWidth / 2}
					y={labelY - estimatedLabelHeight / 2}
					width={estimatedLabelWidth}
					height={estimatedLabelHeight}
					rx="6"
					ry="6"
					className="fill-background/90"
					stroke="currentColor"
					strokeWidth="1"
					strokeOpacity="0.2"
				/>
				{/* Label text */}
				<text
					x={labelX}
					y={labelY}
					textAnchor="middle"
					dominantBaseline="central"
					className="fill-muted-foreground text-sm"
					style={{ fontFamily: "system-ui, sans-serif", fontStyle: "italic" }}
				>
					{config.label}
				</text>
			</g>
			
			{/* Arrow */}
			<CurvedArrow from={{ x: arrowStartX, y: arrowStartY }} to={targetPoint} />
		</>
	);
}

export function WelcomeScreen({ onDismiss }: WelcomeScreenProps) {
	const { refs } = useWelcomeRefs();
	const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());
	
	// Calculate positions from refs
	const updatePositions = useCallback(() => {
		const newPositions = new Map<string, DOMRect>();
		refs.forEach((element, key) => {
			if (element) {
				newPositions.set(key, element.getBoundingClientRect());
			}
		});
		setPositions(newPositions);
	}, [refs]);
	
	// Update positions on mount and resize
	useEffect(() => {
		updatePositions();
		window.addEventListener("resize", updatePositions);
		return () => window.removeEventListener("resize", updatePositions);
	}, [updatePositions]);
	
	// Dismiss when clicking on the first column or add-column button
	useEffect(() => {
		const handleClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const firstColumn = refs.get("first-column");
			const addButton = refs.get("add-column-button");
			
			// Check if click is inside first column or on add button
			if (
				(firstColumn && firstColumn.contains(target)) ||
				(addButton && addButton.contains(target))
			) {
				onDismiss();
			}
		};
		
		// Small delay to avoid immediate dismissal from the click that loaded the page
		const timeoutId = setTimeout(() => {
			window.addEventListener("click", handleClick);
		}, 100);
		
		return () => {
			clearTimeout(timeoutId);
			window.removeEventListener("click", handleClick);
		};
	}, [onDismiss, refs]);
	
	// Get window dimensions for SVG
	const [windowSize, setWindowSize] = useState({ width: 0, height: 0 });
	
	useEffect(() => {
		const updateWindowSize = () => {
			setWindowSize({ width: window.innerWidth, height: window.innerHeight });
		};
		updateWindowSize();
		window.addEventListener("resize", updateWindowSize);
		return () => window.removeEventListener("resize", updateWindowSize);
	}, []);
	
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
			{/* Center content with card background */}
			<div className="flex flex-col items-center gap-3 rounded-xl border border-border/50 bg-background/95 px-8 py-6 shadow-lg backdrop-blur-sm">
				<h1 className="text-4xl font-bold tracking-tight text-brand">
					Todoflare
				</h1>
				<p className="text-muted-foreground italic">
					All your data is saved locally in your browser.
				</p>
			</div>
			
			{/* SVG overlay for annotations */}
			<svg
				className="pointer-events-none fixed inset-0 text-muted-foreground"
				width={windowSize.width}
				height={windowSize.height}
			>
				{annotations.map((config) => {
					const rect = positions.get(config.key);
					if (!rect) return null;
					
					return (
						<Annotation
							key={config.key}
							config={config}
							targetRect={rect}
						/>
					);
				})}
			</svg>
		</div>
	);
}
