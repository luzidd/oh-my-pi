/**
 * Allowlist Gate Extension
 *
 * Inverted permission model: every tool requires user confirmation UNLESS it
 * appears in ALWAYS_ALLOW or is a read-only LSP action.
 *
 * Any future tool added to omp will be blocked by default until explicitly
 * allowlisted here.
 *
 * This is the opposite of permission-gate.ts (which blocklists dangerous patterns).
 * Use this when you want maximum control and want to approve every write/execution.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type Input = Record<string, unknown>;

const ALWAYS_ALLOW = new Set([
	"read", // local paths only — URL reads are intercepted below
	"search",
	"find",
	"ast_grep",
	"calc",
	"ask",
	"todo_write",
	// web_search and read-with-URL are NOT auto-approved: they make outbound
	// network requests that leak query content to external services.
]);

const LSP_READONLY_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

function asString(value: unknown, fallback = ""): string {
	return value !== undefined && value !== null ? String(value) : fallback;
}

function preview(text: string, maxLines = 30): string {
	const lines = text.split("\n");
	return lines.length > maxLines
		? lines.slice(0, maxLines).join("\n") + `\n… (${lines.length - maxLines} more lines)`
		: text;
}

function summarizeAstEdit(input: Input): string {
	const paths = Array.isArray(input.paths) ? input.paths.map(path => asString(path)).filter(Boolean) : [];
	const ops = Array.isArray(input.ops) ? input.ops : [];
	const opPreview = ops
		.slice(0, 3)
		.map(op => {
			const record = op && typeof op === "object" ? (op as Input) : {};
			return `pat: ${asString(record.pat)}\nout: ${preview(asString(record.out), 8)}`;
		})
		.join("\n---\n");

	return [
		paths.length > 0 ? `paths: ${paths.join(", ")}` : "paths: (none)",
		`ops: ${ops.length}`,
		opPreview ? `---\n${opPreview}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function summarizeTask(input: Input): string {
	const agent = asString(input.agent);
	const tasks = Array.isArray(input.tasks) ? input.tasks : [];
	const taskPreview = tasks
		.slice(0, 3)
		.map(task => {
			const record = task && typeof task === "object" ? (task as Input) : {};
			return [
				`id: ${asString(record.id)}`,
				`description: ${asString(record.description)}`,
				`assignment:\n${preview(asString(record.assignment), 12)}`,
			].join("\n");
		})
		.join("\n---\n");

	return [agent ? `agent: ${agent}` : undefined, `tasks: ${tasks.length}`, taskPreview ? `---\n${taskPreview}` : undefined]
		.filter(Boolean)
		.join("\n");
}

function summarize(toolName: string, input: Input): string {
	switch (toolName) {
		case "read":
			return asString(input.path);
		case "bash":
			return asString(input.command);
		case "write":
			return `path: ${input.path}\n---\n${preview(asString(input.content))}`;
		case "edit":
			return `path: ${asString(input.path)}\n---\n${preview(asString(input.input))}`;
		case "ast_edit":
			return summarizeAstEdit(input);
		case "browser":
			return `action: ${asString(input.action)}\nname: ${asString(input.name, "main")}\nurl: ${asString(input.url)}`;
		case "task":
			return summarizeTask(input);
		case "lsp":
			return `action: ${asString(input.action)}\nfile: ${asString(input.file, "workspace")}`;
		case "eval":
			return preview(asString(input.input));
		case "debug":
			return `action: ${asString(input.action)}\nprogram: ${asString(input.program)}\npid: ${asString(input.pid)}`;
		case "recipe":
			return asString(input.op);
		case "resolve":
			return `action: ${asString(input.action)}\nreason: ${asString(input.reason)}`;
		case "ssh":
			return `[${asString(input.host)}] ${asString(input.command)}`;
		case "web_search":
			return asString(input.query);
		default:
			return preview(JSON.stringify(input, null, 2));
	}
}

export default function (omp: ExtensionAPI) {
	omp.on("tool_call", async (event, ctx) => {
		if (ALWAYS_ALLOW.has(event.toolName)) {
			// `read` with an HTTP/HTTPS URL makes an outbound request — treat it
			// the same as web_search: require confirmation.
			if (event.toolName === "read") {
				const path = asString((event.input as Input).path);
				if (/^https?:\/\//i.test(path)) {
					// fall through to confirmation below
				} else {
					return undefined;
				}
			} else {
				return undefined;
			}
		}

		if (event.toolName === "lsp") {
			const action = asString((event.input as Input).action);
			if (LSP_READONLY_ACTIONS.has(action)) return undefined;
		}

		const detail = summarize(event.toolName, event.input as Input);
		const ok = await ctx.ui.confirm(`Allow tool: ${event.toolName}`, detail);
		if (!ok) return { block: true, reason: "Blocked by user" };
		return undefined;
	});
}
