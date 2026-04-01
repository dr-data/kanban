import { Link2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const COLUMN_DISPLAY_NAMES: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	trash: "Trash",
};

/**
 * Full-screen mobile dialog for picking a target task to link to.
 * Shows all tasks grouped by column with a search filter. Tapping a task
 * creates the dependency and closes the dialog.
 */
export function TaskLinkPickerDialog({
	sourceTaskId,
	boardData,
	canLinkTasks,
	onLink,
	onClose,
}: {
	/** The task that initiated the link (source). */
	sourceTaskId: string;
	/** Full board data to display all available tasks. */
	boardData: BoardData;
	/** Validation function — returns true if the two tasks can be linked. */
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	/** Called when the user taps a target task. */
	onLink: (fromTaskId: string, toTaskId: string) => void;
	/** Called to close the dialog without linking. */
	onClose: () => void;
}): React.ReactElement {
	const [search, setSearch] = useState("");
	const searchLower = search.toLowerCase().trim();

	/** All linkable tasks grouped by column, filtered by search and link validity. */
	const groupedTasks = useMemo(() => {
		const groups: { columnId: BoardColumnId; title: string; cards: BoardCard[] }[] = [];
		for (const column of boardData.columns) {
			const eligible = column.cards.filter((card) => {
				if (card.id === sourceTaskId) return false;
				if (canLinkTasks && !canLinkTasks(sourceTaskId, card.id)) return false;
				if (searchLower && !card.prompt.toLowerCase().includes(searchLower)) return false;
				return true;
			});
			if (eligible.length > 0) {
				groups.push({
					columnId: column.id,
					title: COLUMN_DISPLAY_NAMES[column.id],
					cards: eligible,
				});
			}
		}
		return groups;
	}, [boardData.columns, canLinkTasks, searchLower, sourceTaskId]);

	const totalCount = groupedTasks.reduce((sum, g) => sum + g.cards.length, 0);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-surface-0" role="dialog" aria-label="Link to task">
			{/* Header */}
			<div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-1">
				<Link2 size={18} className="text-accent shrink-0" />
				<span className="text-sm font-medium text-text-primary flex-1">Link to task</span>
				<Button variant="ghost" size="sm" icon={<X size={16} />} onClick={onClose} aria-label="Cancel" />
			</div>

			{/* Search */}
			<div className="px-4 py-2 border-b border-border bg-surface-1">
				<input
					type="text"
					placeholder="Search tasks..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="w-full px-3 py-2.5 rounded-md bg-surface-2 border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
					/* biome-ignore lint/a11y/noAutofocus: intentional focus for mobile search dialog */
					autoFocus
				/>
			</div>

			{/* Task list */}
			<div className="flex-1 overflow-y-auto px-4 py-2">
				{totalCount === 0 ? (
					<p className="text-text-tertiary text-sm text-center mt-8">
						{search ? "No matching tasks found" : "No tasks available to link"}
					</p>
				) : (
					groupedTasks.map((group) => (
						<div key={group.columnId} className="mb-4">
							<p className="text-text-tertiary text-xs font-medium uppercase tracking-wider mb-2">
								{group.title}
							</p>
							{group.cards.map((card) => (
								<button
									key={card.id}
									type="button"
									onClick={() => {
										onLink(sourceTaskId, card.id);
										onClose();
									}}
									className="w-full text-left px-3 py-3 mb-1 rounded-md bg-surface-2 border border-border text-sm text-text-primary hover:bg-surface-3 active:bg-surface-4 cursor-pointer transition-colors"
								>
									<span className="line-clamp-2">{card.prompt}</span>
								</button>
							))}
						</div>
					))
				)}
			</div>
		</div>
	);
}
