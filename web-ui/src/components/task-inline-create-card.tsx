import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { ArrowBigUp, Check, ChevronDown, Command, CornerDownLeft } from "lucide-react";
import type { ChangeEvent } from "react";
import { type Dispatch, type ReactElement, type SetStateAction, useCallback, useId, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { BranchSelectDropdown, type BranchSelectOption } from "@/components/branch-select-dropdown";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { Button } from "@/components/ui/button";
import type { TaskAutoReviewMode, TaskImage } from "@/types";
import { pasteShortcutLabel } from "@/utils/platform";
import { useDocumentEvent, useMeasure } from "@/utils/react-use";

export type TaskInlineCardMode = "create" | "edit";

export type TaskBranchOption = BranchSelectOption;

const AUTO_REVIEW_MODE_OPTIONS: Array<{ value: TaskAutoReviewMode; label: string }> = [
	{ value: "commit", label: "Make commit" },
	{ value: "pr", label: "Make PR" },
	{ value: "move_to_trash", label: "Move to Trash" },
];
const AUTO_REVIEW_MODE_SELECT_WIDTH_CH = 16;
const COMPACT_ACTIONS_WIDTH_THRESHOLD_PX = 280;

type PeriodUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

const PERIOD_UNIT_OPTIONS: Array<{ value: PeriodUnit; label: string; ms: number }> = [
	{ value: "seconds", label: "Seconds", ms: 1_000 },
	{ value: "minutes", label: "Minutes", ms: 60_000 },
	{ value: "hours", label: "Hours", ms: 3_600_000 },
	{ value: "days", label: "Days", ms: 86_400_000 },
	{ value: "weeks", label: "Weeks", ms: 604_800_000 },
	{ value: "months", label: "Months", ms: 2_592_000_000 },
];

/** Minimum allowed recurring period in milliseconds (3 minutes). */
const MIN_PERIOD_MS = 180_000;

/** Converts a millisecond period value into a display value and the best-fit unit. */
function msToPeriodDisplay(ms: number): { value: number; unit: PeriodUnit } {
	for (let i = PERIOD_UNIT_OPTIONS.length - 1; i >= 0; i--) {
		const option = PERIOD_UNIT_OPTIONS[i]!;
		if (ms >= option.ms && ms % option.ms === 0) {
			return { value: ms / option.ms, unit: option.value };
		}
	}
	return { value: ms / 1000, unit: "seconds" };
}

/** Converts a display value and unit back to milliseconds. */
function periodDisplayToMs(value: number, unit: PeriodUnit): number {
	const option = PERIOD_UNIT_OPTIONS.find((o) => o.value === unit);
	return value * (option?.ms ?? 1000);
}

/** Converts a unix timestamp to a datetime-local input value string. */
function timestampToDatetimeLocal(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Converts a datetime-local input value string to a unix timestamp. */
function datetimeLocalToTimestamp(value: string): number | null {
	if (!value) {
		return null;
	}
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function ButtonShortcut({ includeShift = false }: { includeShift?: boolean }): ReactElement {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 2,
				marginLeft: 6,
			}}
			aria-hidden
		>
			<Command size={12} />
			{includeShift ? <ArrowBigUp size={12} /> : null}
			<CornerDownLeft size={12} />
		</span>
	);
}

export function TaskInlineCreateCard({
	prompt,
	onPromptChange,
	images,
	onImagesChange,
	onCreate,
	onCreateAndStart,
	onCancel,
	startInPlanMode,
	onStartInPlanModeChange,
	autoReviewEnabled,
	onAutoReviewEnabledChange,
	autoReviewMode,
	onAutoReviewModeChange,
	startInPlanModeDisabled = false,
	workspaceId,
	branchRef,
	branchOptions,
	onBranchRefChange,
	enabled = true,
	mode = "create",
	idPrefix = "inline-task",
	recurringEnabled = false,
	onRecurringEnabledChange,
	recurringMaxIterations = 1,
	onRecurringMaxIterationsChange,
	recurringPeriodMs = 180_000,
	onRecurringPeriodMsChange,
	scheduledStartAt = null,
	onScheduledStartAtChange,
	scheduledEndAt = null,
	onScheduledEndAtChange,
}: {
	prompt: string;
	onPromptChange: (value: string) => void;
	images?: TaskImage[];
	onImagesChange?: Dispatch<SetStateAction<TaskImage[]>>;
	onCreate: () => void;
	onCreateAndStart?: () => void;
	onCancel?: () => void;
	startInPlanMode: boolean;
	onStartInPlanModeChange: (value: boolean) => void;
	autoReviewEnabled: boolean;
	onAutoReviewEnabledChange: (value: boolean) => void;
	autoReviewMode: TaskAutoReviewMode;
	onAutoReviewModeChange: (value: TaskAutoReviewMode) => void;
	startInPlanModeDisabled?: boolean;
	workspaceId: string | null;
	branchRef: string;
	branchOptions: TaskBranchOption[];
	onBranchRefChange: (value: string) => void;
	enabled?: boolean;
	mode?: TaskInlineCardMode;
	idPrefix?: string;
	recurringEnabled?: boolean;
	onRecurringEnabledChange?: (value: boolean) => void;
	recurringMaxIterations?: number;
	onRecurringMaxIterationsChange?: (value: number) => void;
	recurringPeriodMs?: number;
	onRecurringPeriodMsChange?: (value: number) => void;
	scheduledStartAt?: number | null;
	onScheduledStartAtChange?: (value: number | null) => void;
	scheduledEndAt?: number | null;
	onScheduledEndAtChange?: (value: number | null) => void;
}): ReactElement {
	const promptId = `${idPrefix}-prompt-input`;
	const planModeId = `${idPrefix}-plan-mode-toggle`;
	const autoReviewEnabledId = `${idPrefix}-auto-review-enabled-toggle`;
	const autoReviewModeId = `${idPrefix}-auto-review-mode-select`;
	const branchSelectId = `${idPrefix}-branch-select`;
	const recurringEnabledId = useId();
	const scheduledStartId = useId();
	const scheduledEndId = useId();
	const actionLabel = mode === "edit" ? "Save" : "Create";
	const [measureRef, cardRect] = useMeasure<HTMLDivElement>();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [isBranchPopoverOpen, setIsBranchPopoverOpen] = useState(false);
	const setCardRef = useCallback(
		(node: HTMLDivElement | null) => {
			containerRef.current = node;
			if (node) {
				measureRef(node);
			}
		},
		[measureRef],
	);
	const isCompactActions = cardRect.width > 0 && cardRect.width < COMPACT_ACTIONS_WIDTH_THRESHOLD_PX;
	const hideCancelShortcut = isCompactActions;
	const hideCreateShortcut = mode === "create" && isCompactActions;
	const cancelLabel = hideCancelShortcut ? "Cancel" : "Cancel (esc)";
	const cardMarginBottom = mode === "create" ? 6 : 0;

	useHotkeys(
		"escape",
		(event) => {
			if (!onCancel) {
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
				return;
			}
			onCancel();
		},
		{
			enabled: enabled && Boolean(onCancel),
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => event.defaultPrevented,
			preventDefault: true,
		},
		[enabled, mode, onCancel],
	);

	useDocumentEvent(
		"pointerdown",
		(event) => {
			if (!enabled || mode !== "edit" || isBranchPopoverOpen) {
				return;
			}
			const container = containerRef.current;
			if (!container) {
				return;
			}
			if (event.target instanceof Node && container.contains(event.target)) {
				return;
			}
			onCreate();
		},
		true,
	);

	return (
		<div
			ref={setCardRef}
			className="rounded-md border border-border-bright bg-surface-2 p-3"
			style={{ flexShrink: 0, marginBottom: cardMarginBottom, fontSize: 12 }}
		>
			<div>
				<TaskPromptComposer
					id={promptId}
					value={prompt}
					onValueChange={onPromptChange}
					images={images}
					onImagesChange={onImagesChange}
					onSubmit={onCreate}
					onSubmitAndStart={onCreateAndStart}
					onEscape={onCancel}
					placeholder="Describe the task..."
					enabled={enabled}
					autoFocus
					workspaceId={workspaceId}
					showAttachImageButton={false}
				/>
				<p className="text-[11px] text-text-tertiary mt-1 mb-0">
					Use <code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">@file</code> to reference
					files. Drag and drop or{" "}
					<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">{pasteShortcutLabel}</code> to
					add images.
				</p>
			</div>

			<div className="flex flex-col gap-2 mt-3">
				<label
					htmlFor={planModeId}
					className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
				>
					<RadixCheckbox.Root
						id={planModeId}
						aria-label="Start in plan mode"
						checked={startInPlanMode}
						onCheckedChange={(checked) => onStartInPlanModeChange(checked === true)}
						disabled={startInPlanModeDisabled || !enabled}
						className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
					>
						<RadixCheckbox.Indicator>
							<Check size={10} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					<span>Start in plan mode</span>
				</label>

				<div>
					<span className="text-[11px] text-text-secondary block mb-1">Worktree base ref</span>
					<BranchSelectDropdown
						id={branchSelectId}
						options={branchOptions}
						selectedValue={branchRef}
						onSelect={onBranchRefChange}
						onPopoverOpenChange={setIsBranchPopoverOpen}
						fill
						size="sm"
						emptyText="No branches detected"
					/>
				</div>

				<div className="flex items-center gap-2 flex-wrap">
					<label
						htmlFor={autoReviewEnabledId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={autoReviewEnabledId}
							aria-label="Enable automatic review action"
							checked={autoReviewEnabled}
							onCheckedChange={(checked) => onAutoReviewEnabledChange(checked === true)}
							className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
						>
							<RadixCheckbox.Indicator>
								<Check size={10} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						<span>Automatically</span>
					</label>
					<div className="relative inline-flex">
						<select
							id={autoReviewModeId}
							value={autoReviewMode}
							onChange={(event) => onAutoReviewModeChange(event.currentTarget.value as TaskAutoReviewMode)}
							className="h-7 appearance-none rounded-md border border-border-bright bg-surface-2 pl-2 pr-7 text-[12px] text-text-primary cursor-pointer focus:border-border-focus focus:outline-none"
							style={{
								width: `${AUTO_REVIEW_MODE_SELECT_WIDTH_CH}ch`,
								maxWidth: "100%",
							}}
						>
							{AUTO_REVIEW_MODE_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
						<ChevronDown
							size={14}
							className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
						/>
					</div>
				</div>
			</div>

			{onRecurringEnabledChange ? (
				<div className="flex flex-col gap-2 mt-1">
					<label
						htmlFor={recurringEnabledId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={recurringEnabledId}
							checked={recurringEnabled}
							onCheckedChange={(checked) => onRecurringEnabledChange(checked === true)}
							className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
						>
							<RadixCheckbox.Indicator>
								<Check size={10} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						<span>Recurring task</span>
					</label>
					{recurringEnabled ? (
						<div className="flex flex-col gap-2 ml-5.5">
							<div className="flex items-center gap-2">
								<span className="text-[11px] text-text-secondary shrink-0">Max iterations</span>
								<input
									type="number"
									min={0}
									value={recurringMaxIterations}
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										onRecurringMaxIterationsChange?.(Math.max(0, parseInt(e.target.value, 10) || 0))
									}
									className="h-7 w-16 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
								/>
								<span className="text-[10px] text-text-tertiary">0 = unlimited</span>
							</div>
							<div className="flex items-center gap-2 flex-wrap">
								<span className="text-[11px] text-text-secondary shrink-0">Period</span>
								<input
									type="number"
									min={0}
									value={msToPeriodDisplay(recurringPeriodMs).value}
									onChange={(e: ChangeEvent<HTMLInputElement>) => {
										const { unit } = msToPeriodDisplay(recurringPeriodMs);
										const rawMs = periodDisplayToMs(Math.max(0, parseFloat(e.target.value) || 0), unit);
										onRecurringPeriodMsChange?.(Math.max(rawMs, MIN_PERIOD_MS));
									}}
									className="h-7 w-16 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
								/>
								<div className="relative inline-flex">
									<select
										value={msToPeriodDisplay(recurringPeriodMs).unit}
										onChange={(e) => {
											const { value: displayVal } = msToPeriodDisplay(recurringPeriodMs);
											const rawMs = periodDisplayToMs(displayVal, e.currentTarget.value as PeriodUnit);
											onRecurringPeriodMsChange?.(Math.max(rawMs, MIN_PERIOD_MS));
										}}
										className="h-7 appearance-none rounded-md border border-border-bright bg-surface-2 pl-2 pr-6 text-[12px] text-text-primary cursor-pointer focus:border-border-focus focus:outline-none"
									>
										{PERIOD_UNIT_OPTIONS.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label.toLowerCase()}
											</option>
										))}
									</select>
									<ChevronDown
										size={12}
										className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
									/>
								</div>
								{recurringPeriodMs <= MIN_PERIOD_MS ? (
									<span className="text-[10px] text-text-tertiary">Minimum: 3 minutes</span>
								) : null}
							</div>
						</div>
					) : null}
				</div>
			) : null}

			{onScheduledStartAtChange ? (
				<div>
					<label
						htmlFor={scheduledStartId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={scheduledStartId}
							checked={scheduledStartAt != null}
							onCheckedChange={(checked) => {
								if (checked) {
									onScheduledStartAtChange(Date.now() + 5 * 60 * 1000);
								} else {
									onScheduledStartAtChange(null);
									onScheduledEndAtChange?.(null);
								}
							}}
							className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
						>
							<RadixCheckbox.Indicator>
								<Check size={10} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						Scheduled start
					</label>
					{scheduledStartAt != null ? (
						<div className="ml-5.5 mt-1">
							<input
								type="datetime-local"
								value={timestampToDatetimeLocal(scheduledStartAt)}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									onScheduledStartAtChange(datetimeLocalToTimestamp(e.target.value) ?? Date.now())
								}
								className="h-7 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
							/>
						</div>
					) : null}
				</div>
			) : null}

			{onScheduledEndAtChange && scheduledStartAt != null ? (
				<div>
					<label
						htmlFor={scheduledEndId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={scheduledEndId}
							checked={scheduledEndAt != null}
							onCheckedChange={(checked) => {
								if (checked) {
									onScheduledEndAtChange((scheduledStartAt ?? Date.now()) + 60 * 60 * 1000);
								} else {
									onScheduledEndAtChange(null);
								}
							}}
							className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
						>
							<RadixCheckbox.Indicator>
								<Check size={10} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						Scheduled end
					</label>
					{scheduledEndAt != null ? (
						<div className="ml-5.5 mt-1 flex items-center gap-2">
							<input
								type="datetime-local"
								value={timestampToDatetimeLocal(scheduledEndAt)}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									onScheduledEndAtChange(
										datetimeLocalToTimestamp(e.target.value) ?? scheduledStartAt + 60 * 60 * 1000,
									)
								}
								className="h-7 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
							/>
							{scheduledEndAt <= scheduledStartAt ? (
								<span className="text-[10px] text-status-red">End must be after start</span>
							) : null}
						</div>
					) : null}
				</div>
			) : null}

			<div className={`flex gap-2 mt-3 ${mode === "edit" ? "justify-end" : "justify-between"}`}>
				{mode === "create" && onCancel ? (
					<Button variant="default" size="sm" className="whitespace-nowrap" onClick={onCancel}>
						{cancelLabel}
					</Button>
				) : null}
				<div className="flex gap-2">
					<Button
						size="sm"
						className="whitespace-nowrap"
						onClick={onCreate}
						disabled={!prompt.trim() || !branchRef}
					>
						<span className="inline-flex items-center">
							<span>{actionLabel}</span>
							{hideCreateShortcut ? null : <ButtonShortcut />}
						</span>
					</Button>
					{onCreateAndStart ? (
						<Button
							variant="primary"
							size="sm"
							className="whitespace-nowrap"
							onClick={onCreateAndStart}
							disabled={!prompt.trim() || !branchRef}
						>
							<span className="inline-flex items-center">
								<span>Start</span>
								<ButtonShortcut includeShift />
							</span>
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
