import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent";
import readTargetGuard, { classifyTarget, extractGlobBasePath, extractToolTargets } from "../src";

const tmpRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeTempWorkspace(): Promise<{ root: string; cwd: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "read-target-guard-"));
	tmpRoots.push(root);
	const cwd = path.join(root, "session-cwd");
	await mkdir(cwd, { recursive: true });
	return { root, cwd };
}

async function makeSymlinkedOsReleaseFixture(): Promise<{
	cwd: string;
	linkInput: string;
	resolvedPath: string;
	resolvedParent: string;
}> {
	const { root, cwd } = await makeTempWorkspace();
	const resolvedParent = path.join(root, "usr", "lib");
	await mkdir(resolvedParent, { recursive: true });
	const resolvedPath = path.join(resolvedParent, "os-release");
	await writeFile(resolvedPath, "NAME=TestOS\n");
	const linkParent = path.join(root, "etc");
	await mkdir(linkParent, { recursive: true });
	await symlink(path.relative(linkParent, resolvedPath), path.join(linkParent, "os-release"));
	return { cwd, linkInput: "../etc/os-release", resolvedPath, resolvedParent };
}

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;
type ToolResultHandler = (
	event: ToolResultEvent,
	ctx: ExtensionContext,
) => ToolResultEventResult | undefined | Promise<ToolResultEventResult | undefined>;

interface InstalledGuard {
	toolCall: ToolCallHandler;
	toolResult: ToolResultHandler;
}

function installGuard(): InstalledGuard {
	let toolCall: ToolCallHandler | undefined;
	let toolResult: ToolResultHandler | undefined;
	const pi = {
		logger: {
			warn() {},
			debug() {},
		},
		setLabel() {},
		on(event: string, registered: ToolCallHandler | ToolResultHandler) {
			if (event === "tool_call") toolCall = registered as ToolCallHandler;
			if (event === "tool_result") toolResult = registered as ToolResultHandler;
		},
	} as unknown as ExtensionAPI;

	readTargetGuard(pi);
	expect(toolCall).toBeDefined();
	expect(toolResult).toBeDefined();
	return { toolCall: toolCall!, toolResult: toolResult! };
}

function headlessContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			select: async () => {
				throw new Error("headless restricted targets must block without prompting");
			},
			confirm: async () => false,
			input: async () => undefined,
			notify() {},
		},
	} as unknown as ExtensionContext;
}

function uiContext(
	cwd: string,
	choiceLabel: string,
	inspectPrompt?: (title: string, options: readonly { label: string; description?: string }[]) => void,
): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			select: async (title: string, options: readonly { label: string; description?: string }[]) => {
				inspectPrompt?.(title, options);
				const choice = options.find(option => option.label === choiceLabel);
				if (!choice) throw new Error(`Prompt option not found: ${choiceLabel}`);
				return choice.label;
			},
			confirm: async () => false,
			input: async () => undefined,
			notify() {},
		},
	} as unknown as ExtensionContext;
}

function optionDescription(options: readonly { label: string; description?: string }[], label: string): string {
	const option = options.find(option => option.label === label);
	expect(option).toBeDefined();
	if (typeof option?.description !== "string") throw new Error(`Prompt option description not found: ${label}`);
	return option.description;
}

function successfulReadResult(toolCallId: string, pathTarget: string, text = "tool output"): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId,
		toolName: "read",
		input: { path: pathTarget },
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
	};
}

function approvalMetadataText(result: ToolResultEventResult | undefined): string {
	const metadata = result?.content?.[0];
	expect(metadata).toMatchObject({ type: "text" });
	if (metadata?.type !== "text") throw new Error("expected first result content item to be guard metadata text");
	expect(metadata.text).toMatch(/^\[Read Target Guard:/);
	expect(metadata.text).toContain("read access approved");
	return metadata.text;
}

describe("classifyTarget", () => {
	it("allows filesystem targets inside cwd and prompts for siblings outside cwd", async () => {
		const { root, cwd } = await makeTempWorkspace();
		await writeFile(path.join(cwd, "inside.txt"), "inside");
		await writeFile(path.join(root, "outside.txt"), "outside");

		const inside = await classifyTarget("inside.txt", cwd);
		const outside = await classifyTarget("../outside.txt", cwd);

		expect(inside).toMatchObject({
			kind: "filesystem",
			decision: "allow",
			normalized: path.join(cwd, "inside.txt"),
			reason: "Filesystem target is inside cwd",
		});
		expect(outside).toMatchObject({
			kind: "filesystem",
			decision: "prompt",
			normalized: path.join(root, "outside.txt"),
			reason: "Filesystem target is outside the current working directory",
		});
	});

	it("strips read and grep selector suffixes before classification", () => {
		const cases = [
			{ toolName: "read" as const, input: { path: "package.json:1-20" }, expected: ["package.json"] },
			{ toolName: "read" as const, input: { path: "src/foo.ts:raw" }, expected: ["src/foo.ts"] },
			{ toolName: "grep" as const, input: { path: "package.json:1-20" }, expected: ["package.json"] },
			{ toolName: "grep" as const, input: { path: "src/foo.ts:raw" }, expected: ["src/foo.ts"] },
		];

		for (const { toolName, input, expected } of cases) {
			expect(extractToolTargets(toolName, input)).toEqual(expected);
		}
	});

	it("classifies literal colon filenames inside cwd without treating them as selectors", async () => {
		const { cwd } = await makeTempWorkspace();
		await writeFile(path.join(cwd, "test:1-2"), "literal colon filename");

		await expect(classifyTarget("test:1-2", cwd)).resolves.toMatchObject({
			kind: "filesystem",
			decision: "allow",
			normalized: path.join(cwd, "test:1-2"),
			reason: "Filesystem target is inside cwd",
		});
	});

	it("prompts for network read targets by scheme or www shorthand", async () => {
		const { cwd } = await makeTempWorkspace();
		const cases = [
			{
				name: "https URL",
				target: "https://example.com/docs/page?x=1",
				scopeKey: "origin:https://example.com",
			},
			{ name: "www shorthand", target: "www.example.com/docs", scopeKey: "origin:https://www.example.com" },
			{ name: "issue resource", target: "issue://123", scopeKey: "scheme:issue" },
			{ name: "pull request resource", target: "pr://can1357/oh-my-pi/123", scopeKey: "scheme:pr" },
		];

		for (const { target, scopeKey } of cases) {
			const classified = await classifyTarget(target, cwd);
			expect(classified).toMatchObject({
				kind: "network",
				decision: "prompt",
				scopeKey,
				reason: "Network/read-resource targets are outside the current working directory",
			});
		}
	});

	it("allows ssh targets because exec-tier approval owns that risk", async () => {
		const { cwd } = await makeTempWorkspace();

		await expect(classifyTarget("ssh://builder.example.com/var/log/syslog", cwd)).resolves.toMatchObject({
			kind: "ssh",
			decision: "allow",
			scopeKey: "scheme:ssh",
			reason: "SSH target remains governed by the built-in exec-tier approval",
		});
	});

	it("applies the default internal resource policy used by the extension", async () => {
		const { cwd } = await makeTempWorkspace();
		const allowed = ["artifact://result-123", "agent://worker-123/report", "rule://tool-policy"];
		const prompted = ["skill://system-prompts", "local://handoff.md"];

		for (const target of allowed) {
			await expect(classifyTarget(target, cwd)).resolves.toMatchObject({
				kind: "internal",
				decision: "allow",
				scopeKey: `scheme:${target.slice(0, target.indexOf(":"))}`,
			});
		}

		for (const target of prompted) {
			await expect(classifyTarget(target, cwd)).resolves.toMatchObject({
				kind: "internal",
				decision: "prompt",
				scopeKey: `scheme:${target.slice(0, target.indexOf(":"))}`,
			});
		}
	});
});

describe("glob target extraction", () => {
	it("guards the filesystem base before the first glob metacharacter", () => {
		expect(extractGlobBasePath("src/**/*.ts")).toBe("src");
		expect(extractGlobBasePath("packages/read-target-guard/src/*.ts")).toBe("packages/read-target-guard/src");
		expect(extractGlobBasePath("*.md")).toBe(".");
		expect(extractToolTargets("glob", { path: "safe/**/*.ts; ../secrets/*.txt" })).toEqual(["safe", "../secrets"]);
	});

	it("preserves selector-looking literal filenames for glob targets", () => {
		expect(extractToolTargets("glob", { path: "test:1-2" })).toEqual(["test:1-2"]);
	});
});

describe("readTargetGuard extension", () => {
	it("blocks restricted read targets without UI instead of falling through to the tool", async () => {
		const { root, cwd } = await makeTempWorkspace();
		await writeFile(path.join(root, "secret.txt"), "secret");
		const { toolCall, toolResult } = installGuard();

		const result = await toolCall(
			{ type: "tool_call", toolCallId: "call-1", toolName: "read", input: { path: "../secret.txt" } },
			headlessContext(cwd),
		);

		expect(result).toEqual({
			block: true,
			reason: "Read Target Guard blocked a restricted target because no interactive UI is available: ../secret.txt",
		});
		expect(await toolResult(successfulReadResult("call-1", "../secret.txt"), headlessContext(cwd))).toBeUndefined();
	});

	it("does not block allowed read targets in headless mode", async () => {
		const { cwd } = await makeTempWorkspace();
		await writeFile(path.join(cwd, "allowed.txt"), "allowed");
		const { toolCall, toolResult } = installGuard();

		const callResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-2", toolName: "read", input: { path: "allowed.txt" } },
			headlessContext(cwd),
		);

		expect(callResult).toBeUndefined();
		expect(await toolResult(successfulReadResult("call-2", "allowed.txt"), headlessContext(cwd))).toBeUndefined();
	});

	it("prepends approval metadata to successful results for UI-approved restricted reads", async () => {
		const { root, cwd } = await makeTempWorkspace();
		await writeFile(path.join(root, "secret.txt"), "secret");
		const { toolCall, toolResult } = installGuard();

		const callResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-approved", toolName: "read", input: { path: "../secret.txt" } },
			uiContext(cwd, "Allow once"),
		);
		const result = await toolResult(
			successfulReadResult("call-approved", "../secret.txt", "secret"),
			headlessContext(cwd),
		);

		expect(callResult).toBeUndefined();
		const metadata = approvalMetadataText(result);
		expect(metadata).toContain("allowed once");
		expect(metadata).toContain("../secret.txt");
		expect(result?.content?.slice(1)).toEqual([{ type: "text", text: "secret" }]);
	});

	it("labels symlink prompt grants with the resolved path and resolved parent directory", async () => {
		const { cwd, linkInput, resolvedPath, resolvedParent } = await makeSymlinkedOsReleaseFixture();
		const { toolCall } = installGuard();
		let promptOptions: readonly { label: string; description?: string }[] | undefined;

		const callResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-symlink-prompt", toolName: "read", input: { path: linkInput } },
			uiContext(cwd, "Deny", (_title, options) => {
				promptOptions = options;
			}),
		);

		expect(callResult).toEqual({
			block: true,
			reason: `Read Target Guard denied read access to ${linkInput}`,
		});
		if (!promptOptions) throw new Error("expected read target prompt options");
		const targetDescription = optionDescription(promptOptions, "Allow this target for this session");
		const scopeDescription = optionDescription(promptOptions, "Allow this scope for this session");
		expect(targetDescription.endsWith(`path: ${resolvedPath}`)).toBe(true);
		expect(targetDescription).not.toContain(linkInput);
		expect(scopeDescription.endsWith(`parent dir: ${resolvedParent}`)).toBe(true);
		expect(scopeDescription).not.toContain(`parent dir: ${resolvedPath}`);
		expect(scopeDescription).not.toContain(linkInput);
	});

	it("session target grants allow the same normalized restricted target but not sibling paths", async () => {
		const { root, cwd } = await makeTempWorkspace();
		await writeFile(path.join(root, "secret.txt"), "secret");
		await writeFile(path.join(root, "second.txt"), "second");
		const { toolCall, toolResult } = installGuard();

		const grantResult = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-target-grant",
				toolName: "read",
				input: { path: "../nested/../secret.txt" },
			},
			uiContext(cwd, "Allow this target for this session"),
		);
		const grantMetadataResult = await toolResult(
			successfulReadResult("call-target-grant", "../nested/../secret.txt", "secret"),
			headlessContext(cwd),
		);
		const sameTargetResult = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-target-granted-later",
				toolName: "read",
				input: { path: "../secret.txt" },
			},
			headlessContext(cwd),
		);
		const sameTargetMetadataResult = await toolResult(
			successfulReadResult("call-target-granted-later", "../secret.txt", "secret again"),
			headlessContext(cwd),
		);
		const siblingResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-target-sibling", toolName: "read", input: { path: "../second.txt" } },
			headlessContext(cwd),
		);
		const parentResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-target-parent", toolName: "read", input: { path: "../" } },
			headlessContext(cwd),
		);

		expect(grantResult).toBeUndefined();
		const grantMetadata = approvalMetadataText(grantMetadataResult);
		const normalizedSecret = path.join(root, "secret.txt");
		expect(grantMetadata).toContain("allowed path for this session");
		expect(grantMetadata).toContain(`via path: ${normalizedSecret}`);
		expect(grantMetadata).toContain("../nested/../secret.txt");
		expect(grantMetadataResult?.content?.slice(1)).toEqual([{ type: "text", text: "secret" }]);

		expect(sameTargetResult).toBeUndefined();
		const sameTargetMetadata = approvalMetadataText(sameTargetMetadataResult);
		expect(sameTargetMetadata).toContain("allowed by previous session grant");
		expect(sameTargetMetadata).toContain(`via path: ${normalizedSecret}`);
		expect(sameTargetMetadataResult?.content?.slice(1)).toEqual([{ type: "text", text: "secret again" }]);

		expect(siblingResult).toEqual({
			block: true,
			reason: "Read Target Guard blocked a restricted target because no interactive UI is available: ../second.txt",
		});
		expect(
			await toolResult(successfulReadResult("call-target-sibling", "../second.txt", "second"), headlessContext(cwd)),
		).toBeUndefined();
		expect(parentResult).toEqual({
			block: true,
			reason: "Read Target Guard blocked a restricted target because no interactive UI is available: ../",
		});
		expect(
			await toolResult(successfulReadResult("call-target-parent", "../", "parent"), headlessContext(cwd)),
		).toBeUndefined();
	});

	it("prepends previous-session-grant metadata to successful results for matching restricted reads", async () => {
		const { root, cwd } = await makeTempWorkspace();
		await writeFile(path.join(root, "secret.txt"), "secret");
		await writeFile(path.join(root, "second.txt"), "second");
		const { toolCall, toolResult } = installGuard();

		const grantResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-grant", toolName: "read", input: { path: "../secret.txt" } },
			uiContext(cwd, "Allow this scope for this session"),
		);
		const grantMetadataResult = await toolResult(
			successfulReadResult("call-grant", "../secret.txt", "secret"),
			headlessContext(cwd),
		);
		const laterCallResult = await toolCall(
			{ type: "tool_call", toolCallId: "call-granted-later", toolName: "read", input: { path: "../second.txt" } },
			headlessContext(cwd),
		);
		const result = await toolResult(
			successfulReadResult("call-granted-later", "../second.txt", "second"),
			headlessContext(cwd),
		);

		expect(grantResult).toBeUndefined();
		const grantMetadata = approvalMetadataText(grantMetadataResult);
		expect(grantMetadata).toContain("allowed parent dir for this session");
		expect(grantMetadata).toContain(`via parent dir: ${root}`);
		expect(grantMetadata).not.toContain("via scope:");
		expect(grantMetadataResult?.content?.slice(1)).toEqual([{ type: "text", text: "secret" }]);
		expect(laterCallResult).toBeUndefined();
		const metadata = approvalMetadataText(result);
		expect(metadata).toContain("allowed by previous session grant");
		expect(metadata).toContain(`via parent dir: ${root}`);
		expect(metadata).not.toContain("via scope:");
		expect(metadata).toContain("../second.txt");
		expect(result?.content?.slice(1)).toEqual([{ type: "text", text: "second" }]);
	});
});
