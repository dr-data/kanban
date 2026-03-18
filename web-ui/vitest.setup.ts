class MockIntersectionObserver implements IntersectionObserver {
	readonly root = null;
	readonly rootMargin = "0px";
	readonly thresholds = [];

	disconnect(): void {}

	observe(): void {}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	unobserve(): void {}
}

if (typeof globalThis.IntersectionObserver === "undefined") {
	globalThis.IntersectionObserver = MockIntersectionObserver;
}
