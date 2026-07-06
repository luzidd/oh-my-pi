import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { GrantScope, SessionGrantStore } from "./grants";
import type { ClassifiedTarget } from "./types";

export interface PromptDecision {
	allowed: boolean;
	reason: string;
	grantLabel?: string;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_TARGET = "Allow this target for this session";
const ALLOW_SCOPE = "Allow this scope for this session";
const DENY = "Deny";

export async function promptForTargets(
	ui: ExtensionUIContext,
	toolName: string,
	targets: readonly ClassifiedTarget[],
	grants: SessionGrantStore,
): Promise<PromptDecision> {
	const title = formatPromptTitle(toolName, targets);
	const targetGrantLabel = [...new Set(targets.map(target => grants.grantLabel(target, "target")))].join(", ");
	const scopeGrantLabel = [...new Set(targets.map(target => grants.grantLabel(target, "scope")))].join(", ");
	const choice = await ui.select(title, [
		{ label: ALLOW_ONCE, description: "Permit this tool call only." },
		{ label: ALLOW_TARGET, description: formatGrantDescription(targets, "target", targetGrantLabel) },
		{ label: ALLOW_SCOPE, description: formatGrantDescription(targets, "scope", scopeGrantLabel) },
		{ label: DENY, description: "Block this tool call." },
	]);

	if (choice === ALLOW_ONCE) return { allowed: true, reason: "allowed once" };
	if (choice === ALLOW_TARGET) {
		for (const target of targets) {
			grants.grant(target, "target" satisfies GrantScope);
		}
		return { allowed: true, reason: "allowed path for this session", grantLabel: targetGrantLabel };
	}
	if (choice === ALLOW_SCOPE) {
		for (const target of targets) {
			grants.grant(target, "scope" satisfies GrantScope);
		}
		return { allowed: true, reason: "allowed parent dir for this session", grantLabel: scopeGrantLabel };
	}
	return { allowed: false, reason: formatDeniedReason(toolName, targets) };
}

export function formatNoUiBlockReason(targets: readonly ClassifiedTarget[]): string {
	return `Read Target Guard blocked ${targets.length === 1 ? "a restricted target" : "restricted targets"} because no interactive UI is available: ${targets.map(target => target.display).join(", ")}`;
}

function formatPromptTitle(toolName: string, targets: readonly ClassifiedTarget[]): string {
	const lines = [
		"Read target requires approval",
		`Tool: ${toolName}`,
		`Restricted target${targets.length === 1 ? "" : "s"}:`,
	];
	for (const target of targets) {
		lines.push(`- ${target.display}`);
		lines.push(`  kind: ${target.kind}`);
		lines.push(`  reason: ${target.reason}`);
		lines.push(`  scope: ${target.scopeKey}`);
	}
	return lines.join("\n");
}

function formatGrantDescription(targets: readonly ClassifiedTarget[], scope: GrantScope, label: string): string {
	const noun = scope === "target" ? (targets.length === 1 ? "this path" : "these paths") : "matching parent dir/scope";
	return `Permit ${noun} until this session ends: ${label}`;
}

function formatDeniedReason(toolName: string, targets: readonly ClassifiedTarget[]): string {
	return `Read Target Guard denied ${toolName} access to ${targets.map(target => target.display).join(", ")}`;
}
