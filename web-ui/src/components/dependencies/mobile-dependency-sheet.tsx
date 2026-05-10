import { Link2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { BoardColumn, BoardDependency } from "@/types";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

interface MobileDependencySheetProps {
	taskId: string;
	taskTitle: string;
	dependencies: BoardDependency[];
	allColumns: BoardColumn[];
	onDeleteDependency: (dependencyId: string) => void;
	onClose: () => void;
}

/**
 * Finds the "other" task in a dependency (the one that isn't the current task)
 * and resolves its title and column from the board data.
 */
function resolveOtherTask(
	dep: BoardDependency,
	taskId: string,
	allColumns: BoardColumn[],
): { otherTaskId: string; otherTitle: string; columnId: string | null } {
	const otherTaskId = dep.fromTaskId === taskId ? dep.toTaskId : dep.fromTaskId;
	for (const col of allColumns) {
		const card = col.cards.find((c) => c.id === otherTaskId);
		if (card) {
			return {
				otherTaskId,
				otherTitle: truncateTaskPromptLabel(card.prompt, 50),
				columnId: col.id,
			};
		}
	}
	return { otherTaskId, otherTitle: otherTaskId, columnId: null };
}

/**
 * Mobile bottom-sheet style dialog listing all dependencies for a given task.
 * Each row shows the linked task's column indicator, truncated title, and a
 * red delete button to remove the dependency.
 */
export function MobileDependencySheet({
	taskId,
	taskTitle,
	dependencies,
	allColumns,
	onDeleteDependency,
	onClose,
}: MobileDependencySheetProps): React.ReactElement {
	/** Only show dependencies that involve this task. */
	const relevantDeps = dependencies.filter((d) => d.fromTaskId === taskId || d.toTaskId === taskId);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogHeader title="Dependencies" icon={<Link2 size={16} />} />
			<DialogBody>
				<p className="text-xs text-text-secondary mb-3 truncate">
					Links for: <span className="text-text-primary font-medium">{taskTitle}</span>
				</p>
				{relevantDeps.length === 0 ? (
					<p className="text-xs text-text-tertiary text-center py-6">No dependencies</p>
				) : (
					<div className="flex flex-col gap-1.5">
						{relevantDeps.map((dep) => {
							const { otherTitle, columnId } = resolveOtherTask(dep, taskId, allColumns);
							return (
								<div
									key={dep.id}
									className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-2 text-sm"
								>
									{columnId ? <ColumnIndicator columnId={columnId} size={12} /> : null}
									<span className="flex-1 min-w-0 truncate text-text-primary">{otherTitle}</span>
									<Button
										icon={<X size={12} />}
										variant="ghost"
										size="sm"
										className="text-status-red hover:text-status-red shrink-0"
										aria-label="Remove dependency"
										onClick={() => onDeleteDependency(dep.id)}
									/>
								</div>
							);
						})}
					</div>
				)}
			</DialogBody>
		</Dialog>
	);
}
