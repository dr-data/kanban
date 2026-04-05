import { Link2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

const COLUMN_DISPLAY_NAMES: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	trash: "Trash",
};

/** Finds which column a card belongs to. */
function findCardColumn(boardData: BoardData, cardId: string): BoardColumnId | null {
	for (const column of boardData.columns) {
		if (column.cards.some((c) => c.id === cardId)) return column.id;
	}
	return null;
}

/** Truncates a task prompt to a short label. */
function truncatePrompt(prompt: string, maxLen = 40): string {
	const trimmed = prompt.trim().split("\n")[0] ?? prompt.trim();
	return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Full-screen mobile dialog for managing task dependencies. Shows existing
 * links with unlink buttons and a searchable list of linkable tasks grouped
 * by column. Tapping a task creates the dependency and shows a confirmation toast.
 */
export function TaskLinkPickerDialog({
	sourceTaskId,
	boardData,
	dependencies,
	canLinkTasks,
	onLink,
	onUnlink,
	onClose,
}: {
	/** The task that initiated the link (source). */
	sourceTaskId: string;
	/** Full board data to display all available tasks. */
	boardData: BoardData;
	/** All current dependencies on the board. */
	dependencies: BoardDependency[];
	/** Validation function — returns true if the two tasks can be linked. */
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	/** Called when the user taps a target task to create a link. */
	onLink: (fromTaskId: string, toTaskId: string) => void;
	/** Called when the user taps unlink on an existing dependency. */
	onUnlink?: (dependencyId: string) => void;
	/** Called to close the dialog. */
	onClose: () => void;
}): React.ReactElement {
	const [search, setSearch] = useState("");
	const searchLower = search.toLowerCase().trim();

	/** Existing dependencies involving the source task. */
	const existingLinks = useMemo(() => {
		return dependencies
			.filter((d) => d.fromTaskId === sourceTaskId || d.toTaskId === sourceTaskId)
			.map((d) => {
				const linkedTaskId = d.fromTaskId === sourceTaskId ? d.toTaskId : d.fromTaskId;
				const linkedCard = boardData.columns.flatMap((c) => c.cards).find((c) => c.id === linkedTaskId);
				const columnId = findCardColumn(boardData, linkedTaskId);
				return {
					dependencyId: d.id,
					linkedTaskId,
					prompt: linkedCard?.prompt ?? linkedTaskId,
					columnLabel: columnId ? COLUMN_DISPLAY_NAMES[columnId] : "Unknown",
				};
			});
	}, [boardData, dependencies, sourceTaskId]);

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

	const totalLinkable = groupedTasks.reduce((sum, g) => sum + g.cards.length, 0);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-surface-0" role="dialog" aria-label="Link to task">
			{/* Header */}
			<div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-1">
				<Link2 size={18} className="text-accent shrink-0" />
				<span className="text-sm font-medium text-text-primary flex-1">Task dependencies</span>
				<Button variant="ghost" size="sm" icon={<X size={16} />} onClick={onClose} aria-label="Close" />
			</div>

			{/* Existing links section */}
			{existingLinks.length > 0 ? (
				<div className="px-4 py-3 border-b border-border bg-surface-1/50">
					<p className="text-text-tertiary text-xs font-medium uppercase tracking-wider mb-2">
						Linked ({existingLinks.length})
					</p>
					{existingLinks.map((link) => (
						<div
							key={link.dependencyId}
							className="flex items-center gap-2 px-3 py-2.5 mb-1 rounded-md bg-surface-2 border border-border"
						>
							<Link2 size={12} className="text-accent shrink-0" />
							<div className="flex-1 min-w-0">
								<span className="text-sm text-text-primary line-clamp-1">{truncatePrompt(link.prompt)}</span>
								<span className="text-xs text-text-tertiary ml-1">· {link.columnLabel}</span>
							</div>
							{onUnlink ? (
								<Button
									variant="ghost"
									size="sm"
									icon={<Trash2 size={14} />}
									className="text-status-red hover:text-status-red shrink-0"
									aria-label="Remove link"
									onClick={() => onUnlink(link.dependencyId)}
								/>
							) : null}
						</div>
					))}
				</div>
			) : null}

			{/* Search */}
			<div className="px-4 py-2 border-b border-border bg-surface-1">
				<input
					type="text"
					placeholder="Search tasks to link..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="w-full px-3 py-2.5 rounded-md bg-surface-2 border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
					/* biome-ignore lint/a11y/noAutofocus: intentional focus for mobile search dialog */
					autoFocus
				/>
			</div>

			{/* Task list */}
			<div className="flex-1 overflow-y-auto px-4 py-2">
				{totalLinkable === 0 ? (
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
