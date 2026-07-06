import type { ExtensionAPI, ToolCallEventResult, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { classifyTarget, DEFAULT_OPTIONS } from "./classifier";
import { SessionGrantStore } from "./grants";
import { formatNoUiBlockReason, promptForTargets } from "./prompt";
import { extractGlobBasePath, extractToolTargets, isGuardedToolName } from "./tool-targets";
import type { ClassifiedTarget } from "./types";

export default function readTargetGuard(pi: ExtensionAPI): void {
	pi.setLabel("Read Target Guard");
	const grants = new SessionGrantStore();
	const approvedCalls = new Map<string, ApprovalMetadata>();

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!isGuardedToolName(event.toolName)) return undefined;

		const targets = extractToolTargets(event.toolName, event.input as Record<string, unknown>);
		const classified = await classifyTargets(targets, ctx.cwd, pi);
		const approvalTargets = classified.filter(target => target.decision !== "allow");
		const restricted = approvalTargets.filter(target => !grants.allows(target));
		const granted = approvalTargets.filter(target => grants.allows(target));

		if (restricted.length === 0) {
			if (granted.length > 0) {
				approvedCalls.set(event.toolCallId, {
					toolName: event.toolName,
					reason: "allowed by previous session grant",
					targets: granted,
					grantLabel: [
						...new Set(
							granted.map(target => grants.matchedGrantLabel(target)).filter(label => label !== undefined),
						),
					].join(", "),
				});
			}
			return undefined;
		}

		pi.logger.warn("Read Target Guard prompting for restricted target", {
			toolName: event.toolName,
			targets: restricted.map(target => ({ kind: target.kind, display: target.display, scope: target.scopeKey })),
		});

		if (!ctx.hasUI) {
			return { block: true, reason: formatNoUiBlockReason(restricted) };
		}

		const decision = await promptForTargets(ctx.ui, event.toolName, restricted, grants);
		if (decision.allowed) {
			approvedCalls.set(event.toolCallId, {
				toolName: event.toolName,
				reason: decision.reason,
				targets: restricted,
				grantLabel: decision.grantLabel,
			});
			pi.logger.debug("Read Target Guard allowed restricted target", {
				toolName: event.toolName,
				reason: decision.reason,
			});
			return undefined;
		}

		pi.logger.warn("Read Target Guard denied restricted target", {
			toolName: event.toolName,
			reason: decision.reason,
		});
		return { block: true, reason: decision.reason };
	});

	pi.on("tool_result", (event): ToolResultEventResult | undefined => {
		const approved = approvedCalls.get(event.toolCallId);
		if (!approved) return undefined;
		approvedCalls.delete(event.toolCallId);
		if (event.isError) return undefined;
		return {
			content: [
				{
					type: "text",
					text: formatApprovalMetadata(approved),
				},
				...event.content,
			],
		};
	});
}

interface ApprovalMetadata {
	toolName: string;
	reason: string;
	targets: readonly ClassifiedTarget[];
	grantLabel?: string;
}

function formatApprovalMetadata(approved: ApprovalMetadata): string {
	const targets = approved.targets.map(target => `${target.kind}:${target.display}`).join(", ");
	const grant = approved.grantLabel ? ` via ${approved.grantLabel}` : "";
	return `[Read Target Guard: ${approved.toolName} access approved (${approved.reason}${grant}) for ${targets}.]`;
}

async function classifyTargets(targets: readonly string[], cwd: string, pi: ExtensionAPI): Promise<ClassifiedTarget[]> {
	const classified: ClassifiedTarget[] = [];
	for (const target of targets) {
		try {
			classified.push(await classifyTarget(target, cwd, DEFAULT_OPTIONS));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			pi.logger.warn("Read Target Guard failed to classify target", { target, reason });
			classified.push({
				kind: "unknown",
				raw: target,
				normalized: target,
				scopeKey: target,
				display: target,
				decision: "block",
				reason: `Target classification failed: ${reason}`,
			});
		}
	}
	return classified;
}

export type { ClassifiedTarget, GuardedToolName, ReadTargetGuardOptions, TargetDecision, TargetKind } from "./types";
export { classifyTarget, extractGlobBasePath, extractToolTargets, isGuardedToolName, SessionGrantStore };
