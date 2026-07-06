export type GuardedToolName = "read" | "grep" | "glob";

export type TargetKind = "filesystem" | "network" | "internal" | "ssh" | "unknown";

export type TargetDecision = "allow" | "prompt" | "block";

export interface ClassifiedTarget {
	kind: TargetKind;
	raw: string;
	normalized: string;
	scopeKey: string;
	display: string;
	decision: TargetDecision;
	reason: string;
}

export interface ReadTargetGuardOptions {
	allowInternalSchemes: Readonly<Record<string, true>>;
	promptInternalSchemes: Readonly<Record<string, true>>;
	promptNetworkSchemes: Readonly<Record<string, true>>;
	failClosedWithoutUi: boolean;
}

export interface ToolInput {
	[key: string]: unknown;
}
