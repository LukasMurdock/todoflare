"use client";

import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWelcomeRefs } from "@/contexts/welcome-refs-context";

interface WelcomeScreenProps {
	onDismiss: () => void;
}

interface Position {
	x: number;
	y: number;
}

interface Size {
	width: number;
	height: number;
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
		gap: 44,
	},
	{
		key: "add-column-button",
		label: "Add columns",
		arrowTarget: "bottom",
		arrowFrom: "bottom",
		gap: 46,
	},
	{
		key: "shortcuts-button",
		label: "Shortcuts & help",
		arrowTarget: "top",
		arrowFrom: "top",
		gap: 32,
	},
];

// Space kept between a pill and the viewport edge, and between a pill and its arrow.
const EDGE = 12;
const ARROW_GAP = 4;
const ARROW_STAGGER_MS = 120;
// Used until a pill has been measured.
const FALLBACK_PILL: Size = { width: 140, height: 24 };

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

interface Layout {
	pill: { left: number; top: number };
	from: Position;
	to: Position;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** Places a callout pill beside its target and avoids overlapping the center card. */
function layoutAnnotation(
	config: AnnotationConfig,
	rect: DOMRect,
	pill: Size,
	viewport: Size,
	obstacle: DOMRect | null,
): Layout {
	const to = getTargetPoint(rect, config.arrowTarget);
	const labelOffset = config.labelVerticalOffset ?? 0;
	const arrowOffset = config.arrowVerticalOffset ?? 0;
	const clampLeft = (left: number) => clamp(left, EDGE, viewport.width - EDGE - pill.width);
	const clampTop = (top: number) => clamp(top, EDGE, viewport.height - EDGE - pill.height);

	let layout: Layout;
	switch (config.arrowFrom) {
		case "right": {
			const left = clampLeft(to.x + config.gap);
			if (config.key === "first-column") {
				// Aim directly at the "Start typing…" prompt near the top-left of the column.
				const promptTarget = { x: rect.left + Math.min(136, rect.width * 0.45), y: rect.top + 70 };
				const top = clampTop(rect.top + 176);
				layout = {
					pill: { left, top },
					from: { x: left - ARROW_GAP, y: top + pill.height / 2 },
					to: promptTarget,
				};
				break;
			}
			const top = clampTop(to.y + labelOffset - pill.height / 2);
			layout = { pill: { left, top }, from: { x: left - ARROW_GAP, y: top + pill.height / 2 }, to: { x: to.x, y: to.y + arrowOffset * 0.45 } };
			break;
		}
		case "left": {
			const left = clampLeft(to.x - config.gap - pill.width);
			const top = clampTop(to.y + labelOffset - pill.height / 2);
			layout = {
				pill: { left, top },
				from: { x: left + pill.width + ARROW_GAP, y: top + pill.height / 2 },
				to,
			};
			break;
		}
		case "bottom": {
			const left = clampLeft(to.x - pill.width / 2);
			const top = clampTop(to.y + config.gap + labelOffset);
			layout = { pill: { left, top }, from: { x: left + pill.width / 2, y: top - ARROW_GAP + arrowOffset }, to };
			break;
		}
		case "top": {
			const left = clampLeft(to.x - pill.width / 2);
			const top = clampTop(to.y - config.gap - pill.height + labelOffset);
			layout = {
				pill: { left, top },
				from: { x: left + pill.width / 2, y: top + pill.height + ARROW_GAP + arrowOffset },
				to: { x: to.x, y: to.y - ARROW_GAP },
			};
			break;
		}
	}

	// Keep pills clear of the centered welcome card with at least 16px margin.
	if (obstacle && obstacle.width > 0 && obstacle.height > 0) {
		const margin = 16;
		const overlapsX =
			layout.pill.left < obstacle.right + margin && layout.pill.left + pill.width > obstacle.left - margin;
		const overlapsY =
			layout.pill.top < obstacle.bottom + margin && layout.pill.top + pill.height > obstacle.top - margin;
		if (overlapsX && overlapsY) {
			const liftedTop = clampTop(obstacle.top - margin - pill.height);
			layout = {
				...layout,
				pill: { ...layout.pill, top: liftedTop },
				from: { ...layout.from, y: liftedTop + pill.height / 2 },
			};
		}
	}
	return layout;
}

const drawIn = "motion-safe:[animation:tf-arrow-draw_640ms_cubic-bezier(0.22,1,0.36,1)_both]";
const fadeIn = "motion-safe:[animation:tf-fade-in_240ms_ease-out_both]";

function CurvedArrow({ from, to, index }: { from: Position; to: Position; index: number }) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len === 0) return null;

	// Quadratic bezier bowed perpendicular to the line.
	const curveAmount = Math.min(30, len * 0.2);
	const controlX = (from.x + to.x) / 2 + (-dy / len) * curveAmount;
	const controlY = (from.y + to.y) / 2 + (dx / len) * curveAmount;

	// The tangent at t=1 runs from the control point to the end.
	const arrowLength = 7;
	const arrowAngle = Math.PI / 6;
	const tangentAngle = Math.atan2(to.y - controlY, to.x - controlX);
	const head = [tangentAngle - arrowAngle, tangentAngle + arrowAngle].map((angle) => ({
		x: to.x - arrowLength * Math.cos(angle),
		y: to.y - arrowLength * Math.sin(angle),
	}));

	const delay = 240 + index * ARROW_STAGGER_MS;
	return (
		<g>
			<path
				d={`M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.25}
				strokeLinecap="round"
				pathLength={1}
				strokeDasharray="1"
				className={drawIn}
				style={{ animationDelay: `${delay}ms` }}
			/>
			<path
				d={`M ${head[0].x} ${head[0].y} L ${to.x} ${to.y} L ${head[1].x} ${head[1].y}`}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.25}
				strokeLinecap="round"
				strokeLinejoin="round"
				className={fadeIn}
				style={{ animationDelay: `${delay + 480}ms` }}
			/>
		</g>
	);
}

export function WelcomeScreen({ onDismiss }: WelcomeScreenProps) {
	const { refs, version } = useWelcomeRefs();
	const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());
	const [cardRect, setCardRect] = useState<DOMRect | null>(null);
	const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
	const [pillSizes, setPillSizes] = useState<Map<string, Size>>(new Map());
	const cardRef = useRef<HTMLDivElement | null>(null);
	const pillRefs = useRef(new Map<string, HTMLElement>());

	const updatePositions = useCallback(() => {
		const next = new Map<string, DOMRect>();
		refs.forEach((element, key) => next.set(key, element.getBoundingClientRect()));
		setPositions(next);
		setCardRect(cardRef.current ? cardRef.current.getBoundingClientRect() : null);
		setViewport({ width: window.innerWidth, height: window.innerHeight });
	}, [refs]);

	// Re-measure whenever a target registers (the board mounts after this
	// screen), resizes, or the page scrolls or resizes.
	useEffect(() => {
		let frame = 0;
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(updatePositions);
		};
		updatePositions();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		refs.forEach((element) => observer?.observe(element));
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		return () => {
			cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
		};
	}, [refs, version, updatePositions]);

	// Pills size themselves to their text; measure them so placement is exact.
	useLayoutEffect(() => {
		let changed = false;
		const next = new Map(pillSizes);
		pillRefs.current.forEach((element, key) => {
			const { offsetWidth: width, offsetHeight: height } = element;
			const previous = next.get(key);
			if (width > 0 && (previous?.width !== width || previous?.height !== height)) {
				next.set(key, { width, height });
				changed = true;
			}
		});
		if (changed) setPillSizes(next);
	}, [positions, pillSizes]);

	// Dismiss when clicking on the first column or add-column button
	useEffect(() => {
		const handleClick = (event: MouseEvent) => {
			const target = event.target as Node;
			const firstColumn = refs.get("first-column");
			const addButton = refs.get("add-column-button");
			if (firstColumn?.contains(target) || addButton?.contains(target)) {
				onDismiss();
			}
		};
		window.addEventListener("click", handleClick);
		return () => window.removeEventListener("click", handleClick);
	}, [onDismiss, refs]);

	const placed = annotations.flatMap((config) => {
		const rect = positions.get(config.key);
		if (!rect || (rect.width === 0 && rect.height === 0)) return [];
		const size = pillSizes.get(config.key) ?? FALLBACK_PILL;
		return [{ config, layout: layoutAnnotation(config, rect, size, viewport, cardRect), measured: pillSizes.has(config.key) }];
	});

	return (
		<div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
			<div
				ref={cardRef}
				data-welcome-card
				className={`flex flex-col items-start gap-2 rounded-2xl border border-hairline bg-popover/90 px-7 py-5 shadow-pop backdrop-blur-xl max-sm:fixed max-sm:inset-x-4 max-sm:bottom-20 max-sm:items-center ${fadeIn}`}
			>
				<div className="flex items-center gap-3">
					<img
						src="/todoflare-icon.png"
						alt=""
						width={40}
						height={40}
						className="size-10 rounded-[10px] shadow-sm ring-1 ring-black/5 dark:ring-white/10"
					/>
					<h1 className="text-3xl font-bold tracking-[-0.035em] text-foreground">Todoflare</h1>
				</div>
				<p className="text-sm text-muted-foreground">All your data is saved locally in your browser.</p>
			</div>

			<div className="max-sm:hidden">
				<svg
					aria-hidden
					className="pointer-events-none fixed inset-0 text-muted-foreground/70"
					width={viewport.width}
					height={viewport.height}
				>
					{placed.map(({ config, layout, measured }, index) =>
						measured ? <CurvedArrow key={config.key} from={layout.from} to={layout.to} index={index} /> : null,
					)}
				</svg>
				{placed.map(({ config, layout, measured }, index) => (
					<span
						key={config.key}
						ref={(element) => {
							if (element) pillRefs.current.set(config.key, element);
							else pillRefs.current.delete(config.key);
						}}
						className={`fixed inline-flex h-6 items-center rounded-full border border-hairline bg-background/95 px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground shadow-raised ${fadeIn}`}
						style={{
							left: layout.pill.left,
							top: layout.pill.top,
							visibility: measured ? "visible" : "hidden",
							animationDelay: `${160 + index * ARROW_STAGGER_MS}ms`,
						}}
					>
						{config.label}
					</span>
				))}
			</div>
		</div>
	);
}
