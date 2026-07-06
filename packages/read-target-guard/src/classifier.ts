import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassifiedTarget, ReadTargetGuardOptions, TargetKind } from "./types";

const NETWORK_SCHEMES: Readonly<Record<string, true>> = { http: true, https: true, issue: true, pr: true };
const SSH_SCHEMES: Readonly<Record<string, true>> = { ssh: true };

export const DEFAULT_OPTIONS: ReadTargetGuardOptions = {
	allowInternalSchemes: { agent: true, artifact: true, rule: true },
	promptInternalSchemes: { local: true, skill: true },
	promptNetworkSchemes: NETWORK_SCHEMES,
	failClosedWithoutUi: true,
};

export async function classifyTarget(
	rawTarget: string,
	cwd: string,
	options: ReadTargetGuardOptions = DEFAULT_OPTIONS,
): Promise<ClassifiedTarget> {
	const raw = rawTarget.trim();
	if (!raw) {
		return blockUnknown(rawTarget, "Empty tool target cannot be classified");
	}

	if (/^www\./i.test(raw)) {
		return networkTarget(raw, `https://${raw}`);
	}

	const scheme = targetScheme(raw);
	if (scheme) {
		if (SSH_SCHEMES[scheme]) {
			return {
				kind: "ssh",
				raw,
				normalized: raw,
				scopeKey: `scheme:${scheme}`,
				display: raw,
				decision: "allow",
				reason: "SSH target remains governed by the built-in exec-tier approval",
			};
		}
		if (options.promptNetworkSchemes[scheme]) {
			return networkTarget(raw, raw);
		}
		if (scheme === "file") {
			return classifyFilesystemTarget(fileURLToPath(raw), raw, cwd);
		}
		return internalTarget(raw, scheme, options);
	}

	return classifyFilesystemTarget(raw, raw, cwd);
}

function targetScheme(raw: string): string | null {
	const drivePrefix = /^[a-zA-Z]:[\\/]/.test(raw);
	if (drivePrefix) return null;
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
	return match ? match[1]!.toLowerCase() : null;
}

function networkTarget(raw: string, urlLike: string): ClassifiedTarget {
	const normalized = normalizeNetworkTarget(urlLike);
	return {
		kind: "network",
		raw,
		normalized,
		scopeKey: networkScopeKey(normalized),
		display: raw,
		decision: "prompt",
		reason: "Network/read-resource targets are outside the current working directory",
	};
}

function normalizeNetworkTarget(urlLike: string): string {
	try {
		return new URL(urlLike).href;
	} catch {
		return urlLike;
	}
}

function networkScopeKey(normalized: string): string {
	try {
		const url = new URL(normalized);
		if (url.protocol === "http:" || url.protocol === "https:") return `origin:${url.origin}`;
		return `scheme:${url.protocol.slice(0, -1)}`;
	} catch {
		const scheme = targetScheme(normalized);
		return scheme ? `scheme:${scheme}` : `network:${normalized}`;
	}
}

function internalTarget(raw: string, scheme: string, options: ReadTargetGuardOptions): ClassifiedTarget {
	const allowed = options.allowInternalSchemes[scheme] === true && options.promptInternalSchemes[scheme] !== true;
	return {
		kind: "internal",
		raw,
		normalized: raw,
		scopeKey: `scheme:${scheme}`,
		display: raw,
		decision: allowed ? "allow" : "prompt",
		reason: allowed
			? "Harness-internal resource scheme is allowed"
			: `Internal resource scheme '${scheme}:' requires approval`,
	};
}

async function classifyFilesystemTarget(targetPath: string, raw: string, cwd: string): Promise<ClassifiedTarget> {
	const trustedRoot = await canonicalizeExistingPath(cwd);
	const absolute = path.resolve(cwd, expandHome(targetPath));
	const normalized = await canonicalizePossiblyMissingPath(absolute);
	const inside = isInsidePath(trustedRoot, normalized);
	return {
		kind: "filesystem",
		raw,
		normalized,
		scopeKey: normalized,
		display: raw,
		decision: inside ? "allow" : "prompt",
		reason: inside ? "Filesystem target is inside cwd" : "Filesystem target is outside the current working directory",
	};
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

async function canonicalizeExistingPath(existingPath: string): Promise<string> {
	return path.resolve(await fs.realpath(existingPath));
}

async function canonicalizePossiblyMissingPath(candidate: string): Promise<string> {
	const absolute = path.resolve(candidate);
	try {
		return path.resolve(await fs.realpath(absolute));
	} catch {
		return canonicalizeFromNearestExistingParent(absolute);
	}
}

async function canonicalizeFromNearestExistingParent(candidate: string): Promise<string> {
	const parts: string[] = [];
	let current = candidate;
	while (true) {
		try {
			const realParent = await fs.realpath(current);
			return path.resolve(realParent, ...parts.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(candidate);
			parts.push(path.basename(current));
			current = parent;
		}
	}
}

function isInsidePath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function blockUnknown(raw: string, reason: string): ClassifiedTarget {
	return {
		kind: "unknown" as TargetKind,
		raw,
		normalized: raw,
		scopeKey: raw,
		display: raw,
		decision: "block",
		reason,
	};
}
