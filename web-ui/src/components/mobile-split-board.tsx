import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronUp, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { BoardColumn } from "@/components/board-column";
import { TaskLinkPickerDialog } from "@/components/task-link-picker-dialog";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { canCreateTaskDependency } from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

const COLUMN_OPTIONS: { id: BoardColumnId; label: string }[] = [
	{ id: "backlog", label: "Backlog" },
	{ id: "in_progress", label: "In Progress" },
	{ id: "review", label: "Review" },
	{ id: "trash", label: "Trash" },
];

/**
 * Mobile-optimized split board layout. Shows two stacked column panels (top/bottom)
 * with independent column selectors. The bottom panel is collapsible via a drag handle.
 * This layout enables cross-column task linking by making two columns visible simultaneously.
 */
export function MobileSplitBoard({
	data,
	taskSessions,
	dependencies,
	onCreateDependency,
	onDeleteDependency,
	onCardSelect,
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
	workspacePath,
}: {
	data: BoardData;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	dependencies: BoardDependency[];
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
	onDeleteDependency?: (dependencyId: string) => void;
	onCardSelect: (taskId: string) => void;
	onCreateTask: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	workspacePath?: string | null;
}): React.ReactElement {
	const [topColumnId, setTopColumnId] = useState<BoardColumnId>("backlog");
	const [bottomColumnId, setBottomColumnId] = useState<BoardColumnId>("review");
	const [isBottomCollapsed, setIsBottomCollapsed] = useState(false);
	const [mobileLinkSourceTaskId, setMobileLinkSourceTaskId] = useState<string | null>(null);

	const topColumn = data.columns.find((c) => c.id === topColumnId) ?? data.columns[0];
	const bottomColumn = data.columns.find((c) => c.id === bottomColumnId) ?? data.columns[2];

	/** Renders a single column panel with its own column selector. */
	const renderColumnPanel = useCallback(
		(column: (typeof data.columns)[0], position: "top" | "bottom") => {
			const selectedId = position === "top" ? topColumnId : bottomColumnId;
			const setSelectedId = position === "top" ? setTopColumnId : setBottomColumnId;

			return (
				<div className="flex flex-col min-h-0 flex-1 overflow-hidden">
					{/* Column selector */}
					<div className="flex items-center gap-1 px-2 py-1.5 bg-surface-1 border-b border-border shrink-0">
						{COLUMN_OPTIONS.map((opt) => {
							const col = data.columns.find((c) => c.id === opt.id);
							const count = col?.cards.length ?? 0;
							return (
								<button
									key={opt.id}
									type="button"
									onClick={() => setSelectedId(opt.id)}
									className={`px-2 py-1 rounded-md text-[11px] font-medium border-0 cursor-pointer transition-colors ${
										selectedId === opt.id
											? "bg-accent/15 text-accent"
											: "bg-transparent text-text-tertiary hover:text-text-secondary"
									}`}
								>
									{opt.label}
									{count > 0 ? ` ${count}` : ""}
								</button>
							);
						})}
					</div>

					{/* Column content — flex-col needed so BoardColumn's flex-1 section fills the height */}
					<div className="flex flex-col flex-1 min-h-0 overflow-hidden">
						<BoardColumn
							column={column}
							taskSessions={taskSessions}
							onCreateTask={column.id === "backlog" ? onCreateTask : undefined}
							onStartTask={column.id === "backlog" ? onStartTask : undefined}
							onStartAllTasks={column.id === "backlog" ? onStartAllTasks : undefined}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							editingTaskId={column.id === "backlog" ? editingTaskId : null}
							inlineTaskEditor={column.id === "backlog" ? inlineTaskEditor : undefined}
							onEditTask={column.id === "backlog" ? onEditTask : undefined}
							onCommitTask={column.id === "review" ? onCommitTask : undefined}
							onOpenPrTask={column.id === "review" ? onOpenPrTask : undefined}
							onCancelAutomaticTaskAction={onCancelAutomaticTaskAction}
							onMoveToTrashTask={column.id === "review" ? onMoveToTrashTask : undefined}
							onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
							commitTaskLoadingById={column.id === "review" ? commitTaskLoadingById : undefined}
							openPrTaskLoadingById={column.id === "review" ? openPrTaskLoadingById : undefined}
							moveToTrashLoadingById={column.id === "review" ? moveToTrashLoadingById : undefined}
							onTouchLinkStart={setMobileLinkSourceTaskId}
							isMobile
							isDragDisabled
							dependencies={dependencies}
							workspacePath={workspacePath}
							onCardClick={(card) => {
								if (column.id === "backlog") {
									onEditTask?.(card);
									return;
								}
								onCardSelect(card.id);
							}}
						/>
					</div>
				</div>
			);
		},
		[
			topColumnId,
			bottomColumnId,
			data,
			taskSessions,
			dependencies,
			workspacePath,
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
			onCardSelect,
		],
	);

	/** No-op drag handler — mobile uses buttons for card movement, not drag-and-drop.
	 *  DragDropContext is required because BoardColumn uses Droppable internally. */
	const handleDragEnd = useCallback((_result: DropResult) => {}, []);

	return (
		<DragDropContext onDragEnd={handleDragEnd}>
			<div className="flex flex-col flex-1 min-h-0 overflow-hidden">
				{/* Top panel */}
				<div className={`flex flex-col min-h-0 overflow-hidden ${isBottomCollapsed ? "flex-1" : "flex-[1_1_50%]"}`}>
					{topColumn ? renderColumnPanel(topColumn, "top") : null}
				</div>

				{/* Divider / collapse handle */}
				<button
					type="button"
					onClick={() => setIsBottomCollapsed((v) => !v)}
					className="flex items-center justify-center gap-1 h-8 shrink-0 bg-surface-1 border-y border-border cursor-pointer hover:bg-surface-2 transition-colors"
				>
					{isBottomCollapsed ? (
						<ChevronUp size={14} className="text-text-tertiary" />
					) : (
						<ChevronDown size={14} className="text-text-tertiary" />
					)}
					<span className="text-[11px] text-text-tertiary font-medium">
						{isBottomCollapsed ? "Show second column" : "Hide second column"}
					</span>
				</button>

				{/* Bottom panel */}
				{!isBottomCollapsed ? (
					<div className="flex flex-col min-h-0 flex-[1_1_50%] overflow-hidden">
						{bottomColumn ? renderColumnPanel(bottomColumn, "bottom") : null}
					</div>
				) : null}

				{/* Link rule hint */}
				<div className="px-3 py-1.5 bg-surface-1 border-t border-border shrink-0">
					<p className="text-text-tertiary text-[10px] text-center flex items-center justify-center gap-1">
						<Link2 size={10} />
						At least one task must be in Backlog to create a link
					</p>
				</div>
			</div>

			{/* Picker dialog (fallback for complex linking) */}
			{mobileLinkSourceTaskId ? (
				<TaskLinkPickerDialog
					sourceTaskId={mobileLinkSourceTaskId}
					boardData={data}
					dependencies={dependencies}
					canLinkTasks={(from, to) => canCreateTaskDependency(data, from, to)}
					onLink={(from, to) => {
						onCreateDependency?.(from, to);
						const targetCard = data.columns.flatMap((c) => c.cards).find((c) => c.id === to);
						if (targetCard) {
							const label = targetCard.prompt.trim().split("\n")[0]?.slice(0, 30) ?? to;
							toast.success(`Linked to "${label}"`, { duration: 2000 });
						}
					}}
					onUnlink={onDeleteDependency}
					onClose={() => setMobileLinkSourceTaskId(null)}
				/>
			) : null}
		</DragDropContext>
	);
}
