import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, ChevronDown, ChevronRight, Clock, Repeat } from "lucide-react";
import type { ChangeEvent } from "react";
import { useCallback, useId, useState } from "react";

import type { BoardCard } from "@/types";

/** Supported period display units for the recurring period selector. */
type PeriodUnit = "minutes" | "hours" | "days";

const PERIOD_UNIT_OPTIONS: { value: PeriodUnit; label: string }[] = [
	{ value: "minutes", label: "Minutes" },
	{ value: "hours", label: "Hours" },
	{ value: "days", label: "Days" },
];

/** Minimum recurring period in milliseconds (3 minutes). */
const MIN_PERIOD_MS = 180_000;

/** Converts a millisecond value into a human-readable { value, unit } pair. */
function msToPeriodDisplay(ms: number): { value: number; unit: PeriodUnit } {
	if (ms >= 86_400_000 && ms % 86_400_000 === 0) {
		return { value: ms / 86_400_000, unit: "days" };
	}
	if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
		return { value: ms / 3_600_000, unit: "hours" };
	}
	return { value: ms / 60_000, unit: "minutes" };
}

/** Converts a numeric display value and unit back to milliseconds. */
function periodDisplayToMs(value: number, unit: PeriodUnit): number {
	if (unit === "days") return value * 86_400_000;
	if (unit === "hours") return value * 3_600_000;
	return value * 60_000;
}

/** Converts a timestamp to a datetime-local input value string. */
function timestampToDatetimeLocal(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Converts a datetime-local input value string back to an epoch timestamp, or null if empty. */
function datetimeLocalToTimestamp(value: string): number | null {
	if (!value) return null;
	return new Date(value).getTime();
}

interface TaskRecurringScheduleBarProps {
	card: BoardCard;
	onUpdate: (taskId: string, updates: Record<string, unknown>) => void;
	/** When true, renders the settings expanded without the collapsible header. */
	defaultExpanded?: boolean;
}

/**
 * Compact collapsible bar for editing recurring and schedule settings
 * on tasks in any column (in_progress, review, trash). Rendered inside
 * the CardDetailView.
 */
export function TaskRecurringScheduleBar({
	card,
	onUpdate,
	defaultExpanded = false,
}: TaskRecurringScheduleBarProps): React.ReactElement {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const recurringId = useId();
	const schedStartId = useId();
	const schedEndId = useId();

	const hasRecurring = card.recurringEnabled === true;
	const hasSchedule = card.scheduledStartAt != null || card.scheduledEndAt != null;

	const update = useCallback(
		(updates: Record<string, unknown>) => {
			onUpdate(card.id, updates);
		},
		[card.id, onUpdate],
	);

	return (
		<div className="border-b-2 border-accent px-3 py-2 bg-surface-2 shrink-0 overflow-y-auto max-h-[40vh]">
			<button
				type="button"
				onClick={() => setExpanded((p) => !p)}
				className="flex items-center gap-1.5 text-[12px] text-text-primary cursor-pointer select-none w-full"
			>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<span className="flex items-center gap-2">
					Task settings
					{hasRecurring ? (
						<span className="inline-flex items-center gap-0.5 text-status-purple">
							<Repeat size={10} />
							<span className="text-[10px]">Recurring</span>
						</span>
					) : null}
					{hasSchedule ? (
						<span className="inline-flex items-center gap-0.5 text-status-blue">
							<Clock size={10} />
							<span className="text-[10px]">Scheduled</span>
						</span>
					) : null}
				</span>
			</button>

			{expanded ? (
				<div className="flex flex-col gap-2 mt-2 pb-1">
					{/* Recurring enabled */}
					<label
						htmlFor={recurringId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={recurringId}
							checked={hasRecurring}
							onCheckedChange={(checked) => {
								update({ recurringEnabled: checked === true });
							}}
							className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
						>
							<RadixCheckbox.Indicator>
								<Check size={10} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						Recurring task
					</label>

					{hasRecurring ? (
						<div className="flex flex-col gap-2 ml-5.5">
							<div className="flex items-center gap-2">
								<span className="text-[11px] text-text-secondary shrink-0">Max iterations</span>
								<input
									type="number"
									min={0}
									value={card.recurringMaxIterations ?? 1}
									onChange={(e: ChangeEvent<HTMLInputElement>) => {
										update({ recurringMaxIterations: Math.max(0, parseInt(e.target.value, 10) || 0) });
									}}
									className="h-7 w-16 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
								/>
								<span className="text-[10px] text-text-tertiary">0 = unlimited</span>
							</div>
							<div className="flex items-center gap-2 flex-wrap">
								<span className="text-[11px] text-text-secondary shrink-0">Period</span>
								<input
									type="number"
									min={0}
									value={msToPeriodDisplay(card.recurringPeriodMs ?? MIN_PERIOD_MS).value}
									onChange={(e: ChangeEvent<HTMLInputElement>) => {
										const { unit } = msToPeriodDisplay(card.recurringPeriodMs ?? MIN_PERIOD_MS);
										const rawMs = periodDisplayToMs(Math.max(0, parseFloat(e.target.value) || 0), unit);
										update({ recurringPeriodMs: Math.max(rawMs, MIN_PERIOD_MS) });
									}}
									className="h-7 w-16 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
								/>
								<div className="relative inline-flex">
									<select
										value={msToPeriodDisplay(card.recurringPeriodMs ?? MIN_PERIOD_MS).unit}
										onChange={(e) => {
											const { value: displayVal } = msToPeriodDisplay(
												card.recurringPeriodMs ?? MIN_PERIOD_MS,
											);
											const rawMs = periodDisplayToMs(displayVal, e.currentTarget.value as PeriodUnit);
											update({ recurringPeriodMs: Math.max(rawMs, MIN_PERIOD_MS) });
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
							</div>
						</div>
					) : null}

					{/* Scheduled start */}
					<label
						htmlFor={schedStartId}
						className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
					>
						<RadixCheckbox.Root
							id={schedStartId}
							checked={card.scheduledStartAt != null}
							onCheckedChange={(checked) => {
								if (checked) {
									update({ scheduledStartAt: Date.now() + 5 * 60 * 1000 });
								} else {
									update({ scheduledStartAt: null, scheduledEndAt: null });
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
					{card.scheduledStartAt != null ? (
						<div className="ml-5.5">
							<input
								type="datetime-local"
								value={timestampToDatetimeLocal(card.scheduledStartAt)}
								onChange={(e: ChangeEvent<HTMLInputElement>) => {
									update({ scheduledStartAt: datetimeLocalToTimestamp(e.target.value) ?? Date.now() });
								}}
								className="h-7 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
							/>
						</div>
					) : null}

					{/* Scheduled end — only when start is set */}
					{card.scheduledStartAt != null ? (
						<>
							<label
								htmlFor={schedEndId}
								className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
							>
								<RadixCheckbox.Root
									id={schedEndId}
									checked={card.scheduledEndAt != null}
									onCheckedChange={(checked) => {
										if (checked) {
											update({ scheduledEndAt: (card.scheduledStartAt ?? Date.now()) + 60 * 60 * 1000 });
										} else {
											update({ scheduledEndAt: null });
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
							{card.scheduledEndAt != null ? (
								<div className="ml-5.5 flex items-center gap-2">
									<input
										type="datetime-local"
										value={timestampToDatetimeLocal(card.scheduledEndAt)}
										onChange={(e: ChangeEvent<HTMLInputElement>) => {
											update({
												scheduledEndAt:
													datetimeLocalToTimestamp(e.target.value) ??
													(card.scheduledStartAt ?? Date.now()) + 60 * 60 * 1000,
											});
										}}
										className="h-7 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
									/>
									{card.scheduledEndAt <= (card.scheduledStartAt ?? 0) ? (
										<span className="text-[10px] text-status-red">End must be after start</span>
									) : null}
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
