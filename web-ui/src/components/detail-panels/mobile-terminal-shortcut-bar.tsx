import { ChevronDown, ChevronUp, Keyboard, Plus, Settings, X } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { getTerminalController } from "@/terminal/terminal-controller-registry";

export interface TerminalShortcutKey {
	label: string;
	sequence: string;
}

export const DEFAULT_SHORTCUT_KEYS: TerminalShortcutKey[] = [
	{ label: "Esc", sequence: "\u001b" },
	{ label: "Tab", sequence: "\t" },
	{ label: "Ctrl+C", sequence: "\x03" },
	{ label: "\u21e7Tab", sequence: "\u001b[Z" },
	{ label: "1", sequence: "1" },
	{ label: "2", sequence: "2" },
	{ label: "3", sequence: "3" },
];

/** Parses user-entered escape sequences like \\x03, \\t, \\u001b into actual characters. */
function parseSequence(input: string): string {
	return input
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\n/g, "\n");
}

/** Formats a sequence for display, showing control characters as escape codes. */
function displaySequence(seq: string): string {
	if (seq.length === 1 && seq.charCodeAt(0) < 32) {
		return `\\x${seq.charCodeAt(0).toString(16).padStart(2, "0")}`;
	}
	if (seq === "\u001b[Z") return "\\u001b[Z";
	if (seq === "\u001b") return "\\u001b";
	return seq;
}

/** Loads shortcut keys from localStorage, falling back to defaults. */
function loadShortcutKeys(): TerminalShortcutKey[] {
	const stored = readLocalStorageItem(LocalStorageKey.MobileTerminalShortcuts);
	if (!stored) return DEFAULT_SHORTCUT_KEYS;
	try {
		const parsed: unknown = JSON.parse(stored);
		if (
			Array.isArray(parsed) &&
			parsed.every(
				(k) => typeof k === "object" && k !== null && typeof k.label === "string" && typeof k.sequence === "string",
			)
		) {
			return parsed as TerminalShortcutKey[];
		}
	} catch {
		/* ignore parse errors */
	}
	return DEFAULT_SHORTCUT_KEYS;
}

interface MobileTerminalShortcutBarProps {
	taskId: string;
	defaultExpanded?: boolean;
}

/** Collapsible bar of special key buttons for mobile terminal input with inline configuration. */
export function MobileTerminalShortcutBar({
	taskId,
	defaultExpanded = false,
}: MobileTerminalShortcutBarProps): ReactElement {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [keys, setKeys] = useState<TerminalShortcutKey[]>(loadShortcutKeys);
	const [isEditing, setIsEditing] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const [newSequence, setNewSequence] = useState("");

	/** Sends a key sequence to the terminal associated with the given task. */
	const sendKey = (sequence: string) => {
		const controller = getTerminalController(taskId);
		controller?.input(sequence);
	};

	/** Removes a key at the given index and persists the change. */
	const removeKey = (index: number) => {
		setKeys((prev) => {
			const next = prev.filter((_, i) => i !== index);
			writeLocalStorageItem(LocalStorageKey.MobileTerminalShortcuts, JSON.stringify(next));
			return next;
		});
	};

	/** Adds a new key from the input fields and persists the change. */
	const addKey = () => {
		if (!newLabel.trim() || !newSequence.trim()) return;
		const parsed = parseSequence(newSequence.trim());
		setKeys((prev) => {
			const next = [...prev, { label: newLabel.trim(), sequence: parsed }];
			writeLocalStorageItem(LocalStorageKey.MobileTerminalShortcuts, JSON.stringify(next));
			return next;
		});
		setNewLabel("");
		setNewSequence("");
	};

	/** Resets keys to defaults and persists the change. */
	const resetToDefaults = () => {
		setKeys(DEFAULT_SHORTCUT_KEYS);
		writeLocalStorageItem(LocalStorageKey.MobileTerminalShortcuts, JSON.stringify(DEFAULT_SHORTCUT_KEYS));
	};

	return (
		<div className="shrink-0 border-b border-border bg-surface-1">
			<button
				type="button"
				className={cn(
					"flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary",
				)}
				onClick={() => setExpanded((prev) => !prev)}
			>
				<Keyboard size={12} />
				<span>Keys</span>
				{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
				<button
					type="button"
					className="ml-auto text-text-tertiary hover:text-text-primary"
					onClick={(e) => {
						e.stopPropagation();
						setIsEditing((prev) => !prev);
						if (!expanded) setExpanded(true);
					}}
				>
					<Settings size={12} />
				</button>
			</button>
			{expanded ? (
				<>
					<div className="flex flex-wrap gap-1.5 px-3 pb-2">
						{keys.map((key, index) => (
							<button
								key={`${key.label}-${index}`}
								type="button"
								className="rounded-md border border-border bg-surface-3 px-2.5 py-1 font-mono text-xs text-text-primary hover:bg-surface-4 active:bg-accent/20"
								onClick={() => sendKey(key.sequence)}
							>
								{key.label}
							</button>
						))}
					</div>
					{isEditing ? (
						<div className="flex flex-col gap-2 border-t border-border/50 px-3 py-2">
							{keys.map((key, index) => (
								<div key={`edit-${key.label}-${index}`} className="flex items-center gap-2">
									<span className="flex-1 truncate font-mono text-xs text-text-secondary">
										{key.label} → {displaySequence(key.sequence)}
									</span>
									<Button
										variant="ghost"
										size="sm"
										icon={<X size={12} />}
										onClick={() => removeKey(index)}
										aria-label={`Remove ${key.label}`}
									/>
								</div>
							))}
							<div className="flex gap-2">
								<input
									type="text"
									placeholder="Label"
									value={newLabel}
									onChange={(e) => setNewLabel(e.target.value)}
									className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary"
								/>
								<input
									type="text"
									placeholder="e.g. \x03"
									value={newSequence}
									onChange={(e) => setNewSequence(e.target.value)}
									className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
								/>
								<Button
									variant="default"
									size="sm"
									icon={<Plus size={12} />}
									onClick={addKey}
									aria-label="Add key"
								>
									Add
								</Button>
							</div>
							<div className="flex gap-2">
								<Button variant="ghost" size="sm" fill onClick={resetToDefaults}>
									Reset
								</Button>
								<Button variant="default" size="sm" fill onClick={() => setIsEditing(false)}>
									Done
								</Button>
							</div>
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
