import { GitBranch, Trash2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { GitCommitDiffPanel } from "@/components/git-history/git-commit-diff-panel";
import { GitCommitListPanel } from "@/components/git-history/git-commit-list-panel";
import { GitRefsPanel } from "@/components/git-history/git-refs-panel";
import type { UseGitHistoryDataResult } from "@/components/git-history/use-git-history-data";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ResizeHandle } from "@/resize/resize-handle";
import {
	clampGitCommitsPanelWidth,
	clampGitRefsPanelWidth,
	useGitHistoryLayout,
} from "@/resize/use-git-history-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeGitCommit, RuntimeGitRef } from "@/runtime/types";
import { useWindowEvent } from "@/utils/react-use";

function CommitDiffHeader({ commit }: { commit: RuntimeGitCommit }): React.ReactElement {
	return (
		<div
			style={{
				padding: "10px 12px",
				borderBottom: "1px solid var(--color-divider)",
				background: "var(--color-surface-1)",
			}}
		>
			<div
				style={{
					fontSize: 14,
					color: "var(--color-text-primary)",
					marginBottom: 4,
					lineHeight: 1.4,
				}}
			>
				{commit.message}
			</div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					fontSize: 10,
					color: "var(--color-text-tertiary)",
				}}
			>
				<span>{commit.authorName}</span>
				<span>
					{new Date(commit.date).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					})}
				</span>
				<code className="font-mono">{commit.shortHash}</code>
			</div>
		</div>
	);
}

interface GitHistoryViewProps {
	workspaceId: string | null;
	gitHistory: UseGitHistoryDataResult;
	onCheckoutBranch?: (branch: string) => void;
	onDiscardWorkingChanges?: () => void;
	isDiscardWorkingChangesPending?: boolean;
	isMobile?: boolean;
}

export function GitHistoryView({
	workspaceId,
	gitHistory,
	onCheckoutBranch,
	onDiscardWorkingChanges,
	isDiscardWorkingChangesPending = false,
	isMobile = false,
}: GitHistoryViewProps): React.ReactElement {
	const [isDiscardAlertOpen, setIsDiscardAlertOpen] = useState(false);
	const [mobileTab, setMobileTab] = useState<"refs" | "commits" | "diff">("commits");

	/** Selects a ref and auto-navigates to the commits tab on mobile. */
	const handleSelectRef = useCallback(
		(ref: RuntimeGitRef) => {
			gitHistory.selectRef(ref);
			if (isMobile) setMobileTab("commits");
		},
		[gitHistory.selectRef, isMobile],
	);

	/** Selects a commit and auto-navigates to the diff tab on mobile. */
	const handleSelectCommit = useCallback(
		(commit: RuntimeGitCommit) => {
			gitHistory.selectCommit(commit);
			if (isMobile) setMobileTab("diff");
		},
		[gitHistory.selectCommit, isMobile],
	);

	/** Selects the working copy view and auto-navigates to the diff tab on mobile. */
	const handleSelectWorkingCopy = useCallback(() => {
		gitHistory.selectWorkingCopy();
		if (isMobile) setMobileTab("diff");
	}, [gitHistory.selectWorkingCopy, isMobile]);

	const [historyLayoutWidth, setHistoryLayoutWidth] = useState<number | null>(null);
	const historyLayoutRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startRefsPanelResize } = useResizeDrag();
	const { startDrag: startCommitsPanelResize } = useResizeDrag();
	const { displayRefsPanelWidth, displayCommitsPanelWidth, setRefsPanelWidth, setCommitsPanelWidth } =
		useGitHistoryLayout({
			containerWidth: historyLayoutWidth,
		});

	const updateHistoryLayoutWidth = useCallback(() => {
		const container = historyLayoutRef.current;
		if (!container) {
			return;
		}
		setHistoryLayoutWidth(Math.max(container.offsetWidth, 1));
	}, []);

	useEffect(() => {
		updateHistoryLayoutWidth();
	}, [updateHistoryLayoutWidth]);

	useWindowEvent("resize", updateHistoryLayoutWidth);

	const handleRefsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayRefsPanelWidth;
			startRefsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setRefsPanelWidth, startRefsPanelResize],
	);

	const handleCommitsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayCommitsPanelWidth;
			startCommitsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setCommitsPanelWidth, startCommitsPanelResize],
	);

	if (!workspaceId) {
		return (
			<div
				className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary"
				style={{ flex: 1, background: "var(--color-surface-0)" }}
			>
				<GitBranch size={48} />
				<h3 className="font-semibold text-text-primary">No project selected</h3>
			</div>
		);
	}

	const diffHeaderContent =
		gitHistory.viewMode === "commit" && gitHistory.selectedCommit ? (
			<CommitDiffHeader commit={gitHistory.selectedCommit} />
		) : gitHistory.viewMode === "working-copy" ? (
			<div
				className="kb-git-working-copy-header"
				style={{
					display: "flex",
					alignItems: "center",
					padding: "10px 12px",
					borderBottom: "1px solid var(--color-border)",
					fontSize: 14,
					color: "var(--color-text-primary)",
				}}
			>
				<span style={{ flex: 1 }}>Working Copy Changes</span>
				{onDiscardWorkingChanges ? (
					<Button
						variant="danger"
						size="sm"
						icon={<Trash2 size={14} />}
						aria-label="Discard all changes"
						disabled={isDiscardWorkingChangesPending}
						onClick={() => setIsDiscardAlertOpen(true)}
					>
						{isDiscardWorkingChangesPending ? <Spinner size={14} /> : null}
					</Button>
				) : null}
			</div>
		) : null;

	const discardAlert = (
		<AlertDialog
			open={isDiscardAlertOpen}
			onOpenChange={(open) => {
				if (!open) setIsDiscardAlertOpen(false);
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Discard all changes?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					Are you sure you want to discard all working copy changes? This cannot be undone.
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button
						variant="default"
						onClick={() => setIsDiscardAlertOpen(false)}
						disabled={isDiscardWorkingChangesPending}
					>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button
						variant="danger"
						disabled={isDiscardWorkingChangesPending}
						onClick={() => {
							setIsDiscardAlertOpen(false);
							onDiscardWorkingChanges?.();
						}}
					>
						{isDiscardWorkingChangesPending ? <Spinner size={14} /> : null}
						Discard All
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);

	if (isMobile) {
		return (
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flex: "1 1 0",
					minHeight: 0,
					overflow: "hidden",
					background: "var(--color-surface-0)",
				}}
			>
				{/* Tab bar */}
				<div className="kb-mobile-detail-tabs">
					<button
						type="button"
						className="kb-mobile-detail-tab"
						data-active={mobileTab === "refs"}
						onClick={() => setMobileTab("refs")}
					>
						Refs
					</button>
					<button
						type="button"
						className="kb-mobile-detail-tab"
						data-active={mobileTab === "commits"}
						onClick={() => setMobileTab("commits")}
					>
						Commits
					</button>
					<button
						type="button"
						className="kb-mobile-detail-tab"
						data-active={mobileTab === "diff"}
						onClick={() => setMobileTab("diff")}
					>
						Diff
					</button>
				</div>
				{/* Active panel */}
				<div style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
					{mobileTab === "refs" ? (
						<GitRefsPanel
							refs={gitHistory.refs}
							selectedRefName={
								gitHistory.viewMode === "working-copy" ? null : (gitHistory.activeRef?.name ?? null)
							}
							isLoading={gitHistory.isRefsLoading}
							errorMessage={gitHistory.refsErrorMessage}
							panelWidth={9999}
							workingCopyChanges={gitHistory.hasWorkingCopy ? gitHistory.workingCopyFileCount : null}
							isWorkingCopySelected={gitHistory.viewMode === "working-copy"}
							onSelectRef={handleSelectRef}
							onSelectWorkingCopy={gitHistory.hasWorkingCopy ? handleSelectWorkingCopy : undefined}
							onCheckoutRef={onCheckoutBranch}
						/>
					) : mobileTab === "commits" ? (
						<GitCommitListPanel
							commits={gitHistory.commits}
							totalCount={gitHistory.totalCommitCount}
							selectedCommitHash={gitHistory.viewMode === "commit" ? gitHistory.selectedCommitHash : null}
							isLoading={gitHistory.isLogLoading}
							isLoadingMore={gitHistory.isLoadingMoreCommits}
							canLoadMore={gitHistory.commits.length < gitHistory.totalCommitCount}
							errorMessage={gitHistory.logErrorMessage}
							refs={gitHistory.refs}
							panelWidth={9999}
							onSelectCommit={handleSelectCommit}
							onLoadMore={gitHistory.loadMoreCommits}
						/>
					) : (
						<GitCommitDiffPanel
							diffSource={gitHistory.diffSource}
							isLoading={gitHistory.isDiffLoading}
							errorMessage={gitHistory.diffErrorMessage}
							selectedPath={gitHistory.selectedDiffPath}
							onSelectPath={gitHistory.selectDiffPath}
							headerContent={diffHeaderContent}
						/>
					)}
				</div>
				{discardAlert}
			</div>
		);
	}

	return (
		<div
			ref={historyLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			<GitRefsPanel
				refs={gitHistory.refs}
				selectedRefName={gitHistory.viewMode === "working-copy" ? null : (gitHistory.activeRef?.name ?? null)}
				isLoading={gitHistory.isRefsLoading}
				errorMessage={gitHistory.refsErrorMessage}
				panelWidth={displayRefsPanelWidth}
				workingCopyChanges={gitHistory.hasWorkingCopy ? gitHistory.workingCopyFileCount : null}
				isWorkingCopySelected={gitHistory.viewMode === "working-copy"}
				onSelectRef={handleSelectRef}
				onSelectWorkingCopy={gitHistory.hasWorkingCopy ? handleSelectWorkingCopy : undefined}
				onCheckoutRef={onCheckoutBranch}
			/>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize git refs and commits panels"
				onMouseDown={handleRefsSeparatorMouseDown}
				className="z-10"
			/>
			<GitCommitListPanel
				commits={gitHistory.commits}
				totalCount={gitHistory.totalCommitCount}
				selectedCommitHash={gitHistory.viewMode === "commit" ? gitHistory.selectedCommitHash : null}
				isLoading={gitHistory.isLogLoading}
				isLoadingMore={gitHistory.isLoadingMoreCommits}
				canLoadMore={gitHistory.commits.length < gitHistory.totalCommitCount}
				errorMessage={gitHistory.logErrorMessage}
				refs={gitHistory.refs}
				panelWidth={displayCommitsPanelWidth}
				onSelectCommit={handleSelectCommit}
				onLoadMore={gitHistory.loadMoreCommits}
			/>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize git commits and diff panels"
				onMouseDown={handleCommitsSeparatorMouseDown}
				className="z-10"
			/>
			<GitCommitDiffPanel
				diffSource={gitHistory.diffSource}
				isLoading={gitHistory.isDiffLoading}
				errorMessage={gitHistory.diffErrorMessage}
				selectedPath={gitHistory.selectedDiffPath}
				onSelectPath={gitHistory.selectDiffPath}
				headerContent={diffHeaderContent}
			/>
			{discardAlert}
		</div>
	);
}
