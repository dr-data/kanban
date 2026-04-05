import { Droppable } from "@hello-pangea/dnd";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useMemo } from "react";

import { BoardCard } from "@/components/board-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

/** Abbreviated labels for the mobile inline pane selector pills. */
const MOBILE_COLUMN_LABELS: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Prog",
	review: "Review",
	trash: "Trash",
};

const MOBILE_COLUMN_IDS: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

export function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
	isMobileLinkMode,
	onMobileLinkTap,
	workspacePath,
	onMoveToColumn,
	mobilePosition,
	mobileColumnCardCounts,
	onMobileColumnChange,
	isDragDisabled,
	dependencies,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
	/** Whether the mobile tap-based dependency link mode is active. */
	isMobileLinkMode?: boolean;
	/** Callback for a card tap in mobile link mode. Returns true if consumed. */
	onMobileLinkTap?: (taskId: string) => boolean;
	workspacePath?: string | null;
	/** Callback for the mobile "Move to" action on board cards. */
	onMoveToColumn?: (taskId: string, targetColumnId: BoardColumnId) => void;
	/** Position of this column in the mobile dual-pane layout (top, bottom, or hidden). */
	mobilePosition?: "top" | "bottom" | "hidden";
	/** Card counts per column, used by the mobile inline pane selector pills. */
	mobileColumnCardCounts?: Record<BoardColumnId, number>;
	/** Callback to switch which column this mobile pane displays. */
	onMobileColumnChange?: (columnId: BoardColumnId) => void;
	/** When true, disables drag-and-drop for all cards in this column. */
	isDragDisabled?: boolean;
	/** Dependencies for computing per-card link badge counts (mobile only). */
	dependencies?: import("@/types").BoardDependency[];
}): React.ReactElement {
	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const isMobile = useIsMobile();
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		programmaticCardMoveInFlight,
	});

	/** Precomputed map of taskId → dependency count to avoid O(cards × deps) per-card filtering. */
	const dependencyCountByTaskId = useMemo<Map<string, number>>(() => {
		if (!dependencies) return new Map();
		const map = new Map<string, number>();
		for (const dep of dependencies) {
			map.set(dep.fromTaskId, (map.get(dep.fromTaskId) ?? 0) + 1);
			map.set(dep.toTaskId, (map.get(dep.toTaskId) ?? 0) + 1);
		}
		return map;
	}, [dependencies]);
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			{!isMobile && (
				<span aria-hidden className="text-text-secondary">
					(c)
				</span>
			)}
		</span>
	);

	return (
		<section
			data-column-id={column.id}
			data-mobile-position={mobilePosition}
			className="kb-board-column flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden"
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				{/* On mobile, show inline pill selector so users can switch the pane's column */}
				{isMobile && mobilePosition && onMobileColumnChange ? (
					<div className="flex items-center gap-1 px-2 py-1.5 shrink-0">
						<div className="flex gap-1 flex-1 overflow-x-auto">
							{MOBILE_COLUMN_IDS.map((id) => {
								const isActive = id === column.id;
								const count = mobileColumnCardCounts?.[id] ?? 0;
								return (
									<button
										key={id}
										type="button"
										onClick={() => onMobileColumnChange(id)}
										className={cn(
											"flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap",
											isActive ? "bg-accent text-white" : "bg-surface-2 text-text-secondary",
										)}
										aria-current={isActive ? "true" : undefined}
									>
										<ColumnIndicator columnId={id} size={8} />
										{MOBILE_COLUMN_LABELS[id]}
										{count > 0 && <span className="opacity-70">{count}</span>}
									</button>
								);
							})}
						</div>
						{canStartAllTasks ? (
							<Button
								icon={<Play size={14} />}
								variant="ghost"
								size="sm"
								onClick={onStartAllTasks}
								disabled={column.cards.length === 0}
								aria-label="Start all backlog tasks"
							/>
						) : null}
						{canClearTrash ? (
							<Button
								icon={<Trash2 size={14} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-status-red"
								onClick={onClearTrash}
								disabled={column.cards.length === 0}
								aria-label="Clear trash"
							/>
						) : null}
					</div>
				) : (
					<div
						className="flex items-center justify-between"
						style={{
							height: 40,
							padding: "0 12px",
						}}
					>
						<div className="flex items-center gap-2">
							<ColumnIndicator columnId={column.id} />
							<span className="font-semibold text-sm">{column.title}</span>
							<span className="text-text-secondary text-xs">{column.cards.length}</span>
						</div>
						{canStartAllTasks ? (
							<Button
								icon={<Play size={14} />}
								variant="ghost"
								size="sm"
								onClick={onStartAllTasks}
								disabled={column.cards.length === 0}
								aria-label="Start all backlog tasks"
								title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
							/>
						) : null}
						{canClearTrash ? (
							<Button
								icon={<Trash2 size={14} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-status-red"
								onClick={onClearTrash}
								disabled={column.cards.length === 0}
								aria-label="Clear trash"
								title={column.cards.length > 0 ? "Clear trash permanently" : "Trash is empty"}
							/>
						) : null}
					</div>
				)}

				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(cardProvided) => (
						<div ref={cardProvided.innerRef} {...cardProvided.droppableProps} className="kb-column-cards">
							{canCreate ? (
								<Button
									icon={<Plus size={14} />}
									aria-label="Create task"
									fill
									onClick={onCreateTask}
									style={{ marginBottom: 6, flexShrink: 0 }}
								>
									{createTaskButtonText}
								</Button>
							) : null}

							{(() => {
								const items: ReactNode[] = [];
								let draggableIndex = 0;
								for (const card of column.cards) {
									if (column.id === "backlog" && editingTaskId === card.id) {
										items.push(
											<div
												key={card.id}
												data-task-id={card.id}
												data-column-id={column.id}
												style={{ marginBottom: 6 }}
											>
												{inlineTaskEditor}
											</div>,
										);
										continue;
									}
									items.push(
										<BoardCard
											key={card.id}
											card={card}
											index={draggableIndex}
											columnId={column.id}
											sessionSummary={taskSessions[card.id]}
											onStart={onStartTask}
											onMoveToTrash={onMoveToTrashTask}
											onRestoreFromTrash={onRestoreFromTrashTask}
											onCommit={onCommitTask}
											onOpenPr={onOpenPrTask}
											onCancelAutomaticAction={onCancelAutomaticTaskAction}
											isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
											isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
											isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
											onDependencyPointerDown={onDependencyPointerDown}
											onDependencyPointerEnter={onDependencyPointerEnter}
											isDependencySource={dependencySourceTaskId === card.id}
											isDependencyTarget={dependencyTargetTaskId === card.id}
											isDependencyLinking={isDependencyLinking}
											isMobileLinkMode={isMobileLinkMode}
											onMobileLinkTap={onMobileLinkTap}
											workspacePath={workspacePath}
											onMoveToColumn={onMoveToColumn}
											isDragDisabled={isDragDisabled}
											dependencyCount={dependencyCountByTaskId.get(card.id) ?? 0}
											onClick={() => {
												if (column.id === "backlog") {
													onEditTask?.(card);
													return;
												}
												onCardClick?.(card);
											}}
										/>,
									);
									draggableIndex += 1;
								}
								return items;
							})()}
							{cardProvided.placeholder}
						</div>
					)}
				</Droppable>
			</div>
		</section>
	);
}
