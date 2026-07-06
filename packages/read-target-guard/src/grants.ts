import * as path from "node:path";
import type { ClassifiedTarget } from "./types";

export type GrantScope = "target" | "scope";

export class SessionGrantStore {
	readonly #filesystemPaths = new Set<string>();
	readonly #networkScopes = new Set<string>();
	readonly #internalScopes = new Set<string>();

	allows(target: ClassifiedTarget): boolean {
		switch (target.kind) {
			case "filesystem":
				return this.#allowsFilesystem(target.normalized);
			case "network":
				return this.#networkScopes.has(target.scopeKey);
			case "internal":
				return this.#internalScopes.has(target.scopeKey);
			case "ssh":
			case "unknown":
				return false;
		}
	}

	grant(target: ClassifiedTarget, scope: GrantScope): void {
		if (scope === "target") {
			this.#grantTarget(target);
			return;
		}
		this.#grantScope(target);
	}

	grantLabel(target: ClassifiedTarget, scope: GrantScope): string {
		if (scope === "target") return targetGrantLabel(target);
		return scopeGrantLabel(target);
	}

	matchedGrantLabel(target: ClassifiedTarget): string | undefined {
		switch (target.kind) {
			case "filesystem":
				return this.#matchedFilesystemGrantLabel(target.normalized);
			case "network":
				return this.#networkScopes.has(target.scopeKey) ? `network scope: ${target.scopeKey}` : undefined;
			case "internal":
				return this.#internalScopes.has(target.scopeKey) ? `internal scope: ${target.scopeKey}` : undefined;
			case "ssh":
			case "unknown":
				return undefined;
		}
	}

	#grantTarget(target: ClassifiedTarget): void {
		switch (target.kind) {
			case "filesystem":
				this.#filesystemPaths.add(target.normalized);
				return;
			case "network":
				this.#networkScopes.add(target.normalized);
				return;
			case "internal":
				this.#internalScopes.add(target.normalized);
				return;
			case "ssh":
			case "unknown":
				return;
		}
	}

	#grantScope(target: ClassifiedTarget): void {
		switch (target.kind) {
			case "filesystem":
				this.#filesystemPaths.add(filesystemScopePath(target.normalized));
				return;
			case "network":
				this.#networkScopes.add(target.scopeKey);
				return;
			case "internal":
				this.#internalScopes.add(target.scopeKey);
				return;
			case "ssh":
			case "unknown":
				return;
		}
	}

	#allowsFilesystem(candidate: string): boolean {
		for (const allowed of this.#filesystemPaths) {
			const relative = path.relative(allowed, candidate);
			if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
		}
		return false;
	}

	#matchedFilesystemGrantLabel(candidate: string): string | undefined {
		for (const allowed of this.#filesystemPaths) {
			const relative = path.relative(allowed, candidate);
			if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
				return allowed === candidate ? `path: ${allowed}` : `parent dir: ${allowed}`;
			}
		}
		return undefined;
	}
}

function targetGrantLabel(target: ClassifiedTarget): string {
	switch (target.kind) {
		case "filesystem":
			return `path: ${target.normalized}`;
		case "network":
			return `network target: ${target.normalized}`;
		case "internal":
			return `internal target: ${target.normalized}`;
		case "ssh":
			return `ssh target: ${target.normalized}`;
		case "unknown":
			return `target: ${target.normalized}`;
	}
}

function scopeGrantLabel(target: ClassifiedTarget): string {
	switch (target.kind) {
		case "filesystem":
			return `parent dir: ${filesystemScopePath(target.normalized)}`;
		case "network":
			return `network scope: ${target.scopeKey}`;
		case "internal":
			return `internal scope: ${target.scopeKey}`;
		case "ssh":
			return `ssh scope: ${target.scopeKey}`;
		case "unknown":
			return `scope: ${target.scopeKey}`;
	}
}

function filesystemScopePath(targetPath: string): string {
	return path.dirname(targetPath);
}
