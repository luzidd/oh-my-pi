import * as path from "node:path";
import type { GuardedToolName, ToolInput } from "./types";

const GLOB_META_RE = /[*?[{]/;
const SELECTOR_RE = /:(?:raw|conflicts|(?:raw:)?\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*|\d+(?:[-+]\d*)?:raw)$/;

export function isGuardedToolName(toolName: string): toolName is GuardedToolName {
	return toolName === "read" || toolName === "grep" || toolName === "glob";
}

export function extractToolTargets(toolName: GuardedToolName, input: ToolInput): string[] {
	switch (toolName) {
		case "read":
			return extractReadTargets(input);
		case "grep":
			return extractGrepTargets(input);
		case "glob":
			return extractGlobTargets(input);
	}
}

function extractReadTargets(input: ToolInput): string[] {
	const raw = input.path;
	return typeof raw === "string" && raw.trim().length > 0 ? [raw.trim().replace(SELECTOR_RE, "")] : [];
}

function extractGrepTargets(input: ToolInput): string[] {
	const raw = input.path ?? input.paths;
	const values = pathList(raw).map(target => target.replace(SELECTOR_RE, ""));
	return values.length > 0 ? values : ["."];
}

function extractGlobTargets(input: ToolInput): string[] {
	const raw = input.path;
	const values = pathList(raw);
	if (values.length === 0) return ["."];
	return values.map(extractGlobBasePath);
}

function pathList(value: unknown): string[] {
	const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(";") : [];
	return rawItems.map(item => String(item).trim()).filter(Boolean);
}

export function extractGlobBasePath(pattern: string): string {
	const trimmed = pattern.trim();
	if (!trimmed) return ".";

	const metaIndex = trimmed.search(GLOB_META_RE);
	if (metaIndex === -1) return trimmed;

	const prefix = trimmed.slice(0, metaIndex);
	if (!prefix) return ".";

	const lastSlash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
	if (lastSlash === -1) return ".";

	const base = prefix.slice(0, lastSlash + 1);
	if (!base) return ".";

	const parsed = path.parse(base);
	if (base === parsed.root) return parsed.root;
	return base.replace(/[\\/]+$/, "") || parsed.root || ".";
}
