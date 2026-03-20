import { Pencil } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

export function TaskTitleDialog({
	open,
	title,
	onTitleChange,
	onClose,
	onSave,
}: {
	open: boolean;
	title: string;
	onTitleChange: (value: string) => void;
	onClose: () => void;
	onSave: () => void;
}): ReactElement {
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		window.requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
			<DialogHeader title="Edit title" icon={<Pencil size={16} />} />
			<DialogBody>
				<label htmlFor="task-title-dialog-input" className="mb-2 block text-[12px] text-text-secondary">
					Title
				</label>
				<input
					id="task-title-dialog-input"
					ref={inputRef}
					value={title}
					onChange={(event) => onTitleChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							onSave();
						}
					}}
					className="h-9 w-full rounded-md border border-border-bright bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					placeholder="Task title"
				/>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" onClick={onSave}>
					Save
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
