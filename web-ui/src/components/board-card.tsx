import { Draggable } from "@hello-pangea/dnd";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { formatClineToolCallLabel } from "@runtime-cline-tool-call-display";
import { buildTaskWorktreeDisplayPath } from "@runtime-task-worktree-path";
import {
	AlertCircle,
	Clock,
	GitBranch,
	Link2,
	MoveHorizontal,
	Play,
	Repeat,
	RotateCcw,
	Settings,
	Trash2,
} from "lucide-react";
import { type MouseEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { isAllowedCrossColumnCardMove } from "@/state/drag-rules";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { formatPathForDisplay } from "@/utils/path-display";
import { useMeasure } from "@/utils/react-use";
import {
	clampTextWithInlineSuffix,
	splitPromptToTitleDescriptionByWidth,
	truncateTaskPromptLabel,
} from "@/utils/task-prompt";
import { DEFAULT_TEXT_MEASURE_FONT, measureTextWidth, readElementFontShorthand } from "@/utils/text-measure";

interface CardSessionActivity {
	dotColor: string;
	text: string;
}

const SESSION_ACTIVITY_COLOR = {
	thinking: "var(--color-status-blue)",
	success: "var(--color-status-green)",
	waiting: "var(--color-status-gold)",
	error: "var(--color-status-red)",
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

const DESCRIPTION_COLLAPSE_LINES = 3;
const SESSION_PREVIEW_COLLAPSE_LINES = 6;
const DESCRIPTION_EXPAND_LABEL = "See more";
const DESCRIPTION_COLLAPSE_LABEL = "Less";
const DESCRIPTION_COLLAPSE_SUFFIX = `… ${DESCRIPTION_EXPAND_LABEL}`;

/** Human-readable labels for each board column, used in the mobile move-to menu. */
const COLUMN_LABELS: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	trash: "Trash",
};

/** All column IDs in board order, used to compute mobile move targets. */
const ALL_COLUMN_IDS: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

/**
 * Formats a future unix timestamp into a human-readable relative string,
 * e.g. "Starts in 2h 15m" or "Starts in 30s".
 */
function formatRelativeTime(targetMs: number): string {
	const diffMs = targetMs - Date.now();
	if (diffMs <= 0) {
		return "Starting now";
	}
	const totalSeconds = Math.floor(diffMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return minutes > 0 ? `Starts in ${hours}h ${minutes}m` : `Starts in ${hours}h`;
	}
	if (minutes > 0) {
		return `Starts in ${minutes}m`;
	}
	return `Starts in ${seconds}s`;
}

/**
 * Formats a period in milliseconds into a human-readable string,
 * e.g. "3m", "1h", "2d", "1w".
 */
function formatPeriod(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.round(ms / 3_600_000);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.round(ms / 86_400_000);
	if (days < 7) {
		return `${days}d`;
	}
	const weeks = Math.round(ms / 604_800_000);
	return `${weeks}w`;
}

function reconstructTaskWorktreeDisplayPath(taskId: string, workspacePath: string | null | undefined): string | null {
	if (!workspacePath) {
		return null;
	}
	try {
		return buildTaskWorktreeDisplayPath(taskId, workspacePath);
	} catch {
		return null;
	}
}

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		return formatClineToolCallLabel(
			toolName,
			toolInputSummary ?? extractToolInputSummaryFromActivityText(activityText ?? "", toolName),
		);
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return formatClineToolCallLabel(parsed.toolName, parsed.toolInputSummary);
}

/**
 * Detects whether a "running" session is actually stale — the process has
 * exited (pid is null) but the state machine never transitioned out of
 * "running". This can happen when process exit events are missed.
 */
function isStaleRunningSession(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.state !== "running") {
		return false;
	}
	return summary.pid === null;
}

function getCardSessionActivity(summary: RuntimeTaskSessionSummary | undefined): CardSessionActivity | null {
	if (!summary) {
		return null;
	}

	/* If state is "running" but the process is gone, show a stale indicator
	   instead of an endlessly spinning "Thinking..." label. */
	if (isStaleRunningSession(summary)) {
		const lastActivity = summary.latestHookActivity?.finalMessage?.trim();
		return {
			dotColor: SESSION_ACTIVITY_COLOR.muted,
			text: lastActivity || "Session ended",
		};
	}

	const hookActivity = summary.latestHookActivity;
	const activityText = hookActivity?.activityText?.trim();
	const toolName = hookActivity?.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity?.toolInputSummary?.trim() ?? null;
	const finalMessage = hookActivity?.finalMessage?.trim();
	const hookEventName = hookActivity?.hookEventName?.trim() ?? null;
	if (summary.state === "awaiting_review" && finalMessage) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: finalMessage };
	}
	if (
		finalMessage &&
		!toolName &&
		(hookEventName === "assistant_delta" || hookEventName === "agent_end" || hookEventName === "turn_start")
	) {
		return {
			dotColor: summary.state === "running" ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.success,
			text: finalMessage,
		};
	}
	if (activityText) {
		let dotColor: string =
			summary.state === "failed" ? SESSION_ACTIVITY_COLOR.error : SESSION_ACTIVITY_COLOR.thinking;
		let text = activityText;
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			if (text.startsWith("Failed ")) {
				dotColor = SESSION_ACTIVITY_COLOR.error;
			}
			return {
				dotColor,
				text: toolCallLabel,
			};
		}
		if (text.startsWith("Final: ")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
			text = text.slice(7);
		} else if (text.startsWith("Agent: ")) {
			text = text.slice(7);
		} else if (text.startsWith("Waiting for approval")) {
			dotColor = SESSION_ACTIVITY_COLOR.waiting;
		} else if (text.startsWith("Waiting for review")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
		} else if (text.startsWith("Failed ")) {
			dotColor = SESSION_ACTIVITY_COLOR.error;
		} else if (text === "Agent active" || text === "Working on task" || text.startsWith("Resumed")) {
			return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
		}
		return { dotColor, text };
	}
	if (summary.state === "failed") {
		const failedText = finalMessage ?? activityText ?? "Task failed to start";
		return { dotColor: SESSION_ACTIVITY_COLOR.error, text: failedText };
	}
	if (summary.state === "awaiting_review") {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" };
	}
	if (summary.state === "running") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}

/**
 * Dropdown menu that lets mobile users move a card to another column.
 * Renders a small ghost button with a MoveHorizontal icon that opens a
 * Radix DropdownMenu listing valid destination columns with color indicators.
 */
function MobileMoveToMenu({
	cardId,
	targets,
	onMoveToColumn,
	stopEvent,
}: {
	cardId: string;
	targets: BoardColumnId[];
	onMoveToColumn: (taskId: string, targetColumnId: BoardColumnId) => void;
	stopEvent: (event: MouseEvent<HTMLElement>) => void;
}): React.ReactElement {
	return (
		<DropdownMenu.Root>
			<Tooltip content="Move to...">
				<DropdownMenu.Trigger asChild>
					<Button
						icon={<MoveHorizontal size={14} />}
						variant="ghost"
						size="sm"
						aria-label="Move to..."
						onMouseDown={stopEvent}
						onClick={stopEvent}
					/>
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50 min-w-[140px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					{targets.map((targetColumnId) => (
						<DropdownMenu.Item
							key={targetColumnId}
							className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3"
							onSelect={() => onMoveToColumn(cardId, targetColumnId)}
						>
							<ColumnIndicator columnId={targetColumnId} size={12} />
							{COLUMN_LABELS[targetColumnId]}
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/**
 * Renders a single Kanban card with session status, action buttons, and dependency linking support.
 * Wrapped in React.memo to prevent cascading re-renders when stable parent callbacks (e.g. onCardClick)
 * are passed down from KanbanBoard, preserving smooth drag-and-drop and mobile pane performance.
 */
export const BoardCard = memo(function BoardCard({
	card,
	index,
	columnId,
	sessionSummary,
	selected = false,
	onClick,
	onStart,
	onMoveToTrash,
	onRestoreFromTrash,
	onCommit,
	onOpenPr,
	onCancelAutomaticAction,
	isCommitLoading = false,
	isOpenPrLoading = false,
	isMoveToTrashLoading = false,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	isMobileLinkMode = false,
	onMobileLinkTap,
	workspacePath,
	onMoveToColumn,
	isDragDisabled = false,
	dependencyCount = 0,
	onEnterMobileLinkMode,
	onShowMobileDependencies,
	onUpdateTask: _onUpdateTask,
	onEditTask,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	onClick?: () => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onCommit?: (taskId: string) => void;
	onOpenPr?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	isMoveToTrashLoading?: boolean;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	/** When true, card taps trigger the mobile dependency linking flow instead of navigation. */
	isMobileLinkMode?: boolean;
	/** Callback for a card tap in mobile link mode. Returns true if the tap was consumed. */
	onMobileLinkTap?: (taskId: string) => boolean;
	workspacePath?: string | null;
	/** Callback for the mobile "Move to" action on board cards. */
	onMoveToColumn?: (taskId: string, targetColumnId: BoardColumnId) => void;
	/** When true, prevents drag-and-drop for this card (used in mobile layout). */
	isDragDisabled?: boolean;
	/** Number of dependencies this card has (for badge display on mobile). */
	dependencyCount?: number;
	/** Callback to activate mobile tap-based dependency link mode with this card as source. */
	onEnterMobileLinkMode?: (taskId: string) => void;
	/** Callback to open the mobile dependency sheet for a given task. */
	onShowMobileDependencies?: (taskId: string) => void;
	/** Callback to update recurring/schedule fields on a task. */
	onUpdateTask?: (taskId: string, updates: Record<string, unknown>) => void;
	/** Callback to open the task editor for this card. */
	onEditTask?: (card: BoardCardModel) => void;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [titleContainerRef, titleRect] = useMeasure<HTMLDivElement>();
	const [descriptionContainerRef, descriptionRect] = useMeasure<HTMLDivElement>();
	const [sessionPreviewContainerRef, sessionPreviewRect] = useMeasure<HTMLDivElement>();
	const titleRef = useRef<HTMLParagraphElement | null>(null);
	const descriptionRef = useRef<HTMLParagraphElement | null>(null);
	const sessionPreviewRef = useRef<HTMLParagraphElement | null>(null);
	const [titleWidthFallback, setTitleWidthFallback] = useState(0);
	const [descriptionWidthFallback, setDescriptionWidthFallback] = useState(0);
	const [sessionPreviewWidthFallback, setSessionPreviewWidthFallback] = useState(0);
	const [titleFont, setTitleFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [descriptionFont, setDescriptionFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [sessionPreviewFont, setSessionPreviewFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
	const [isSessionPreviewExpanded, setIsSessionPreviewExpanded] = useState(false);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const isTrashCard = columnId === "trash";
	const isMobile = useIsMobile();

	/* Re-render every 30s to keep the schedule countdown badge fresh. */
	const [, setScheduleTick] = useState(0);
	const hasSchedule = card.scheduledStartAt != null && columnId === "backlog";
	useEffect(() => {
		if (!hasSchedule) {
			return;
		}
		const id = window.setInterval(() => setScheduleTick((n) => n + 1), 30_000);
		return () => window.clearInterval(id);
	}, [hasSchedule]);

	/** Valid destination columns for the mobile "Move to" dropdown. */
	const mobileMoveTargets = useMemo(
		() =>
			ALL_COLUMN_IDS.filter((targetId) => targetId !== columnId && isAllowedCrossColumnCardMove(columnId, targetId)),
		[columnId],
	);

	const isCardInteractive = !isTrashCard;
	const titleWidth = titleRect.width > 0 ? titleRect.width : titleWidthFallback;
	const descriptionWidth = descriptionRect.width > 0 ? descriptionRect.width : descriptionWidthFallback;
	const sessionPreviewWidth = sessionPreviewRect.width > 0 ? sessionPreviewRect.width : sessionPreviewWidthFallback;
	const displayPrompt = useMemo(() => {
		return card.prompt.trim();
	}, [card.prompt]);
	const rawSessionActivity = useMemo(() => getCardSessionActivity(sessionSummary), [sessionSummary]);
	const lastSessionActivityRef = useRef<CardSessionActivity | null>(null);
	const lastSessionActivityCardIdRef = useRef<string | null>(null);
	if (lastSessionActivityCardIdRef.current !== card.id) {
		lastSessionActivityCardIdRef.current = card.id;
		lastSessionActivityRef.current = null;
	}
	if (rawSessionActivity) {
		lastSessionActivityRef.current = rawSessionActivity;
	}
	const sessionActivity = rawSessionActivity ?? lastSessionActivityRef.current;
	const displayPromptSplit = useMemo(() => {
		const fallbackTitle = truncateTaskPromptLabel(card.prompt);
		if (!displayPrompt) {
			return {
				title: fallbackTitle,
				description: "",
			};
		}
		if (titleWidth <= 0) {
			return {
				title: fallbackTitle,
				description: "",
			};
		}
		const split = splitPromptToTitleDescriptionByWidth(displayPrompt, {
			maxTitleWidthPx: titleWidth,
			measureText: (value) => measureTextWidth(value, titleFont),
		});
		return {
			title: split.title || fallbackTitle,
			description: split.description,
		};
	}, [card.prompt, displayPrompt, titleFont, titleWidth]);

	useLayoutEffect(() => {
		if (titleRect.width > 0) {
			return;
		}
		const nextWidth = titleRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== titleWidthFallback) {
			setTitleWidthFallback(nextWidth);
		}
	}, [titleRect.width, titleWidthFallback]);

	useLayoutEffect(() => {
		if (descriptionRect.width > 0 || !displayPromptSplit.description) {
			return;
		}
		const nextWidth = descriptionRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== descriptionWidthFallback) {
			setDescriptionWidthFallback(nextWidth);
		}
	}, [descriptionRect.width, descriptionWidthFallback, displayPromptSplit.description]);

	useLayoutEffect(() => {
		if (sessionPreviewRect.width > 0 || !isTrashCard || !sessionActivity?.text) {
			return;
		}
		const nextWidth = sessionPreviewRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== sessionPreviewWidthFallback) {
			setSessionPreviewWidthFallback(nextWidth);
		}
	}, [isTrashCard, sessionActivity?.text, sessionPreviewRect.width, sessionPreviewWidthFallback]);

	useLayoutEffect(() => {
		setTitleFont(readElementFontShorthand(titleRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [titleWidth]);

	useLayoutEffect(() => {
		setDescriptionFont(readElementFontShorthand(descriptionRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [descriptionWidth, displayPromptSplit.description]);

	useLayoutEffect(() => {
		setSessionPreviewFont(readElementFontShorthand(sessionPreviewRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [sessionActivity?.text, sessionPreviewWidth]);

	useEffect(() => {
		setIsDescriptionExpanded(false);
	}, [card.id, displayPromptSplit.description]);

	useEffect(() => {
		setIsSessionPreviewExpanded(false);
	}, [card.id, sessionActivity?.text]);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const isDescriptionMeasured = descriptionRect.width > 0;
	const isSessionPreviewMeasured = sessionPreviewRect.width > 0;

	const descriptionDisplay = useMemo(() => {
		if (!displayPromptSplit.description) {
			return {
				text: "",
				isTruncated: false,
			};
		}
		if (descriptionWidth <= 0) {
			return {
				text: displayPromptSplit.description,
				isTruncated: false,
			};
		}
		return clampTextWithInlineSuffix(displayPromptSplit.description, {
			maxWidthPx: descriptionWidth,
			maxLines: DESCRIPTION_COLLAPSE_LINES,
			suffix: DESCRIPTION_COLLAPSE_SUFFIX,
			measureText: (value) => measureTextWidth(value, descriptionFont),
		});
	}, [descriptionFont, descriptionWidth, displayPromptSplit.description]);

	const sessionPreviewDisplay = useMemo(() => {
		if (!sessionActivity?.text) {
			return {
				text: "",
				isTruncated: false,
			};
		}
		if (sessionPreviewWidth <= 0) {
			return {
				text: sessionActivity.text,
				isTruncated: false,
			};
		}
		return clampTextWithInlineSuffix(sessionActivity.text, {
			maxWidthPx: sessionPreviewWidth,
			maxLines: SESSION_PREVIEW_COLLAPSE_LINES,
			suffix: DESCRIPTION_COLLAPSE_SUFFIX,
			measureText: (value) => measureTextWidth(value, sessionPreviewFont),
		});
	}, [sessionActivity?.text, sessionPreviewFont, sessionPreviewWidth]);

	const renderStatusMarker = () => {
		if (columnId === "in_progress") {
			if (sessionSummary?.state === "failed") {
				return <AlertCircle size={12} className="text-status-red" />;
			}
			/* Stop the spinner for stale sessions where the process is gone. */
			if (sessionSummary && isStaleRunningSession(sessionSummary)) {
				return <AlertCircle size={12} className="text-text-tertiary" />;
			}
			return <Spinner size={12} />;
		}
		return null;
	};
	const statusMarker = renderStatusMarker();
	const showWorkspaceStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const reviewWorkspacePath = reviewWorkspaceSnapshot
		? formatPathForDisplay(reviewWorkspaceSnapshot.path)
		: isTrashCard
			? reconstructTaskWorktreeDisplayPath(card.id, workspacePath)
			: null;
	const reviewRefLabel = reviewWorkspaceSnapshot?.branch ?? reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? "HEAD";
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	const showReviewGitActions = columnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;
	const isAnyGitActionLoading = isCommitLoading || isOpenPrLoading;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={isDragDisabled}>
			{(provided, snapshot) => {
				const isDragging = snapshot.isDragging;
				const draggableContent = (
					<div
						ref={provided.innerRef}
						{...provided.draggableProps}
						{...provided.dragHandleProps}
						className="kb-board-card-shell"
						data-task-id={card.id}
						data-column-id={columnId}
						data-selected={selected}
						onMouseDownCapture={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (!event.metaKey && !event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							onDependencyPointerDown?.(card.id, event);
						}}
						onClick={(event) => {
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							/* In mobile link mode, taps create dependencies instead of navigating. */
							if (isMobileLinkMode && onMobileLinkTap) {
								event.preventDefault();
								event.stopPropagation();
								onMobileLinkTap(card.id);
								return;
							}
							if (event.metaKey || event.ctrlKey) {
								return;
							}
							if (!snapshot.isDragging && onClick) {
								onClick();
							}
						}}
						style={{
							...provided.draggableProps.style,
							marginBottom: 6,
							cursor: "grab",
							touchAction: "pan-y pinch-zoom",
						}}
						onMouseEnter={() => {
							setIsHovered(true);
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseMove={() => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseLeave={() => setIsHovered(false)}
					>
						<div
							className={cn(
								"rounded-md border border-border-bright bg-surface-2 p-2.5",
								isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
								isDragging && "shadow-lg",
								isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
								isDependencySource && "kb-board-card-dependency-source",
								isMobileLinkMode && isDependencySource && "kb-board-card-dependency-source-touch",
								isDependencyTarget && "kb-board-card-dependency-target",
							)}
						>
							<div className="flex items-center gap-2" style={{ minHeight: 24 }}>
								{statusMarker ? <div className="inline-flex items-center">{statusMarker}</div> : null}
								<div ref={titleContainerRef} className="flex-1 min-w-0">
									<p
										ref={titleRef}
										className={cn(
											"kb-line-clamp-1 m-0 font-medium text-sm",
											isTrashCard && "line-through text-text-tertiary",
										)}
									>
										{displayPromptSplit.title}
									</p>
								</div>
								{columnId === "backlog" ? (
									<Button
										icon={<Play size={14} />}
										variant="ghost"
										size="sm"
										aria-label="Start task"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onStart?.(card.id);
										}}
									/>
								) : columnId === "review" ? (
									<Button
										icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
										variant="ghost"
										size="sm"
										disabled={isMoveToTrashLoading}
										aria-label="Move task to trash"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMoveToTrash?.(card.id);
										}}
									/>
								) : columnId === "trash" ? (
									<Tooltip
										side="bottom"
										content={
											<>
												Restore session
												<br />
												in new worktree
											</>
										}
									>
										<Button
											icon={<RotateCcw size={12} />}
											variant="ghost"
											size="sm"
											aria-label="Restore task from trash"
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onRestoreFromTrash?.(card.id);
											}}
										/>
									</Tooltip>
								) : null}
								{columnId !== "backlog" && onEditTask ? (
									<Button
										icon={<Settings size={14} />}
										variant="ghost"
										size="sm"
										aria-label="Edit task settings"
										onMouseDown={stopEvent}
										onClick={(e) => {
											stopEvent(e);
											onEditTask(card);
										}}
									/>
								) : null}
								{isMobile && mobileMoveTargets.length > 0 && onMoveToColumn ? (
									<MobileMoveToMenu
										cardId={card.id}
										targets={mobileMoveTargets}
										onMoveToColumn={onMoveToColumn}
										stopEvent={stopEvent}
									/>
								) : null}
								{isMobile && columnId !== "trash" && onEnterMobileLinkMode ? (
									<Tooltip content="Link tasks">
										<Button
											icon={<Link2 size={14} />}
											variant="ghost"
											size="sm"
											aria-label="Link to another task"
											onMouseDown={stopEvent}
											onClick={(e) => {
												stopEvent(e);
												onEnterMobileLinkMode(card.id);
											}}
										/>
									</Tooltip>
								) : null}
								{isMobile && dependencyCount > 0 && onShowMobileDependencies ? (
									<button
										type="button"
										className="inline-flex items-center gap-0.5 text-[11px] text-text-tertiary"
										aria-label={`View ${dependencyCount} dependencies`}
										onMouseDown={stopEvent}
										onClick={(e) => {
											stopEvent(e);
											onShowMobileDependencies(card.id);
										}}
									>
										<Link2 size={10} />
										{dependencyCount}
									</button>
								) : null}
							</div>
							{displayPromptSplit.description ? (
								<div ref={descriptionContainerRef}>
									<p
										ref={descriptionRef}
										className={cn(
											"text-sm leading-[1.4]",
											isTrashCard ? "text-text-tertiary" : "text-text-secondary",
											!isDescriptionMeasured && !isDescriptionExpanded && "line-clamp-3",
										)}
										style={{
											margin: "2px 0 0",
										}}
									>
										{isDescriptionExpanded || !descriptionDisplay.isTruncated
											? displayPromptSplit.description
											: descriptionDisplay.text}
										{descriptionDisplay.isTruncated ? (
											isDescriptionExpanded ? (
												<>
													{" "}
													<button
														type="button"
														className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
														aria-expanded={isDescriptionExpanded}
														aria-label="Collapse task description"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															setIsDescriptionExpanded(false);
														}}
													>
														{DESCRIPTION_COLLAPSE_LABEL}
													</button>
												</>
											) : (
												<>
													{"… "}
													<button
														type="button"
														className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
														aria-expanded={isDescriptionExpanded}
														aria-label="Expand task description"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															setIsDescriptionExpanded(true);
														}}
													>
														{DESCRIPTION_EXPAND_LABEL}
													</button>
												</>
											)
										) : null}
									</p>
								</div>
							) : null}
							{sessionActivity ? (
								<div
									className="flex gap-1.5 items-start mt-[6px]"
									style={{
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									<span
										className="inline-block shrink-0 rounded-full"
										style={{
											width: 6,
											height: 6,
											backgroundColor: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : sessionActivity.dotColor,
											marginTop: 4,
										}}
									/>
									<div ref={sessionPreviewContainerRef} className="min-w-0 flex-1">
										<p
											ref={sessionPreviewRef}
											className={cn(
												"m-0 font-mono",
												!isSessionPreviewMeasured && !isSessionPreviewExpanded && "line-clamp-6",
											)}
											style={{
												fontSize: 12,
												whiteSpace: "normal",
												overflowWrap: "anywhere",
											}}
										>
											{isSessionPreviewExpanded || !sessionPreviewDisplay.isTruncated
												? sessionActivity.text
												: sessionPreviewDisplay.text}
											{sessionPreviewDisplay.isTruncated ? (
												isSessionPreviewExpanded ? (
													<>
														{" "}
														<button
															type="button"
															className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
															aria-expanded={isSessionPreviewExpanded}
															aria-label="Collapse task agent preview"
															onMouseDown={stopEvent}
															onClick={(event) => {
																stopEvent(event);
																setIsSessionPreviewExpanded(false);
															}}
														>
															{DESCRIPTION_COLLAPSE_LABEL}
														</button>
													</>
												) : (
													<>
														{"… "}
														<button
															type="button"
															className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
															aria-expanded={isSessionPreviewExpanded}
															aria-label="Expand task agent preview"
															onMouseDown={stopEvent}
															onClick={(event) => {
																stopEvent(event);
																setIsSessionPreviewExpanded(true);
															}}
														>
															{DESCRIPTION_EXPAND_LABEL}
														</button>
													</>
												)
											) : null}
										</p>
									</div>
								</div>
							) : null}
							{showWorkspaceStatus && reviewWorkspacePath ? (
								<p
									className="font-mono"
									style={{
										margin: "4px 0 0",
										fontSize: 12,
										lineHeight: 1.4,
										whiteSpace: "normal",
										overflowWrap: "anywhere",
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									{isTrashCard ? (
										<span
											style={{
												color: SESSION_ACTIVITY_COLOR.muted,
												textDecoration: "line-through",
											}}
										>
											{reviewWorkspacePath}
										</span>
									) : reviewWorkspaceSnapshot ? (
										<>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewWorkspacePath}</span>
											<GitBranch
												size={10}
												style={{
													display: "inline",
													color: SESSION_ACTIVITY_COLOR.secondary,
													margin: "0px 4px 2px",
													verticalAlign: "middle",
												}}
											/>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewRefLabel}</span>
											{reviewChangeSummary ? (
												<>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}> (</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>
														{reviewChangeSummary.filesLabel}
													</span>
													<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
													<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>)</span>
												</>
											) : null}
										</>
									) : null}
								</p>
							) : null}
							{card.recurringEnabled ? (
								<span className="text-[10px] text-text-secondary inline-flex items-center gap-0.5 flex-wrap mt-1">
									<Repeat size={11} />
									<span>
										Recurring{" "}
										{(card.recurringMaxIterations ?? 0) === 0
											? `${card.recurringCurrentIteration ?? 0}/\u221E`
											: `${card.recurringCurrentIteration ?? 0}/${card.recurringMaxIterations}`}
									</span>
									{card.recurringPeriodMs ? (
										<span className="text-text-tertiary">every {formatPeriod(card.recurringPeriodMs)}</span>
									) : null}
								</span>
							) : null}
							{card.scheduledStartAt != null && columnId === "backlog" ? (
								<span className="text-[10px] text-status-gold inline-flex items-center gap-1 mt-1">
									<Clock size={11} />
									{formatRelativeTime(card.scheduledStartAt)}
									{card.scheduledEndAt != null ? (
										<span className="text-text-tertiary">
											{" "}
											until {formatRelativeTime(card.scheduledEndAt)}
										</span>
									) : null}
								</span>
							) : null}
							{showReviewGitActions ? (
								<div className="flex gap-1.5 mt-1.5">
									<Button
										variant="primary"
										size="sm"
										icon={isCommitLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onCommit?.(card.id);
										}}
									>
										Commit
									</Button>
									<Button
										variant="primary"
										size="sm"
										icon={isOpenPrLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onOpenPr?.(card.id);
										}}
									>
										Open PR
									</Button>
								</div>
							) : null}
							{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
								<Button
									size="sm"
									fill
									style={{ marginTop: 12 }}
									onMouseDown={stopEvent}
									onClick={(event) => {
										stopEvent(event);
										onCancelAutomaticAction(card.id);
									}}
								>
									{cancelAutomaticActionLabel}
								</Button>
							) : null}
						</div>
					</div>
				);

				if (isDragging && typeof document !== "undefined") {
					return createPortal(draggableContent, document.body);
				}
				return draggableContent;
			}}
		</Draggable>
	);
});
