function currentNodeMajorVersion(): number | null {
	const majorVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
	return Number.isFinite(majorVersion) ? majorVersion : null;
}

export function shouldLogNode22CiDiagnostics(): boolean {
	if (!process.env.CI) {
		return false;
	}
	const majorVersion = currentNodeMajorVersion();
	return majorVersion !== null && majorVersion >= 22;
}

function describeResource(resource: unknown): string {
	if (!resource || typeof resource !== "object") {
		return typeof resource;
	}

	const candidate = resource as {
		constructor?: { name?: string };
		pid?: number;
		fd?: number;
	};
	const name = candidate.constructor?.name ?? "unknown";

	if (name === "ChildProcess" && typeof candidate.pid === "number") {
		return `${name}(pid=${String(candidate.pid)})`;
	}

	if (typeof candidate.fd === "number") {
		return `${name}(fd=${String(candidate.fd)})`;
	}

	return name;
}

export function logActiveResources(label: string): void {
	const inspector = process as NodeJS.Process & {
		_getActiveHandles?: () => unknown[];
		_getActiveRequests?: () => unknown[];
	};
	const handles = inspector._getActiveHandles?.() ?? [];
	const requests = inspector._getActiveRequests?.() ?? [];
	const handleSummary = handles.map((handle) => describeResource(handle)).join(", ");
	const requestSummary = requests.map((request) => describeResource(request)).join(", ");

	console.error(
		`[vitest diagnostics] ${label}: handles=${String(handles.length)} [${handleSummary}] requests=${String(
			requests.length,
		)} [${requestSummary}]`,
	);
}
