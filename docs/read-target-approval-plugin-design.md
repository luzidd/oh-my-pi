# Read Target Approval Plugin Design

## Goal

Provide immediate local privacy hardening for Oh My Pi by implementing a plugin/extension that prompts before built-in read-like tools access targets outside the current working directory or access non-local schemes such as `https://` and `issue://`.

This is intentionally a plugin-first design so the user can protect their own machine before a core PR for [#3293](https://github.com/can1357/oh-my-pi/issues/3293) is accepted and merged.

## Problem

Oh My Pi's current approval model is tier-based:

- `read`
- `write`
- `exec`

With `tools.approvalMode: always-ask`, read-tier tools are still auto-approved. That is reasonable for ordinary project reads, but unsafe when the same read tier covers:

- local project files;
- local files outside the intended workspace;
- web/network reads;
- internal resource schemes;
- remote/SSH resources.

The built-in `read` tool currently classifies every non-SSH target as read-tier. In practice this means a model can call `read` on paths such as `~/.ssh/config`, `~/.omp/agent/config.yml`, `https://...`, or `issue://...` without an approval prompt when read-tier calls are auto-approved.

## Non-goals

This plugin is not a complete sandbox.

Out of scope for the first plugin version:

- sandboxing `bash` commands;
- blocking implicit reads by LSP, MCP servers, browser automation, provider SDKs, or spawned subprocesses;
- replacing the built-in approval system;
- implementing OS-level confinement such as Landlock/AppContainer/sandbox-exec;
- guaranteeing protection against malicious code already executing inside the plugin process.

The goal is defense-in-depth for ordinary model tool calls through the read-like built-in tools.

## Security model

The plugin treats the current working directory (`ctx.cwd`) as the default trust root.

This is deliberately **not** repo-root scoped. If the user starts `omp` in a subdirectory of a repository, only that subdirectory should be auto-approved. If the user wants the whole repository trusted, they should start `omp` from the repository root.

Default trust boundary:

```text
trusted filesystem root = realpath(ctx.cwd)
```

A filesystem target is auto-approved only when its resolved realpath is equal to or inside that trusted root.

Examples when `ctx.cwd = /repo/packages/coding-agent`:

| Target | Default decision | Reason |
|---|---:|---|
| `package.json` | allow | inside cwd |
| `src/tools/read.ts` | allow | inside cwd |
| `../ai/package.json` | prompt | outside cwd, even if inside same repo |
| `/repo/package.json` | prompt | outside cwd |
| `~/.ssh/config` | prompt | outside cwd |
| `/etc/hosts` | prompt | outside cwd |

## Extension mechanism

Use an Oh My Pi **extension**, not a hook.

Reasoning:

- Extension `tool_call` handlers can block tool execution.
- Extension handlers receive `ctx.cwd` and can use `ctx.ui` to prompt interactively.
- Hooks intentionally cannot call UI primitives; they are unsuitable for approval prompts.

Relevant observed API behavior:

- Built-in approval runs before extension `tool_call` handlers.
- The plugin therefore cannot modify the built-in approval decision directly.
- The plugin can still enforce an additional security gate by prompting in `tool_call` and returning `{ block: true, reason }` when denied.
- If no UI is available and a prompt would be required, the plugin should fail closed by blocking the tool call.

## Covered tools

Initial coverage should include read-like tools with direct target arguments:

- `read`
- `grep`
- `glob`

Later coverage can add mutating tools:

- `write`
- `edit`
- `ast_grep`
- `ast_edit`

The first plugin version should focus on `read`, `grep`, and `glob` because they are the privacy leak under `always-ask`: they can disclose arbitrary file contents, filenames, or remote resource contents while remaining read-tier.

## Read target classifier

Implement a shared classifier that maps a tool call to one or more security targets.

```ts
type ReadTargetKind =
  | "filesystem"
  | "network"
  | "internal"
  | "ssh"
  | "unknown";

interface ClassifiedTarget {
  kind: ReadTargetKind;
  raw: string;
  normalized: string;
  scopeKey: string;
  display: string;
  decision: "allow" | "prompt" | "block";
  reason: string;
}
```

### Filesystem targets

Filesystem targets include:

- no-scheme local paths;
- relative paths;
- absolute paths;
- `~` paths;
- `file://` paths.

Selectors must be stripped before filesystem resolution:

```text
src/foo.ts:10-20       -> src/foo.ts
~/secret.txt:raw       -> ~/secret.txt
archive.zip:file.ts    -> archive.zip for outer filesystem approval
```

The plugin should resolve filesystem paths with these steps:

1. expand `~`;
2. resolve relative paths against `ctx.cwd`;
3. if the path exists, canonicalize with `realpath`;
4. if the path does not exist, canonicalize the nearest existing parent and append the unresolved tail;
5. compare against `realpath(ctx.cwd)`.

Decision:

- inside cwd root -> allow;
- outside cwd root -> prompt;
- resolution error that prevents safe classification -> block or prompt, depending config; default should be prompt if UI exists, block if not.

### Network targets

Network targets include:

- `http://...`;
- `https://...`;
- `www....` normalized to HTTPS or treated as network;
- `issue://...`;
- `pr://...`.

`issue://` and `pr://` are not local resources. They should use the same override mechanism as `https://` because resolving them may fetch external GitHub data or disclose the user's intent to access an external resource.

Decision:

- allowed network scope -> allow;
- new network scope -> prompt;
- denied network scope -> block.

Suggested network grant keys:

| Target | Scope key |
|---|---|
| `https://github.com/can1357/oh-my-pi/issues/3293` | `origin:https://github.com` |
| `http://example.com/path` | `origin:http://example.com` |
| `issue://3293` | `scheme:issue` or `github:issue` initially |
| `pr://123` | `scheme:pr` or `github:pr` initially |

For the first plugin version, use coarse scheme-level grants for `issue://` and `pr://`. A later version can map them to GitHub origins once owner/repo resolution is available.

### Internal targets

Internal targets include harness-owned schemes such as:

- `artifact://`;
- `agent://`;
- `local://`;
- `skill://`;
- `rule://`.

Default policy should be configurable. Recommended initial default:

- allow `artifact://`, `agent://`, and `rule://`;
- prompt for `local://` and `skill://` only if desired by config;
- treat unknown internal schemes as prompt.

Rationale: internal resources are generally not arbitrary filesystem reads, but some may still contain user-authored private data. The plugin should make this explicit rather than silently classifying them as filesystem or network.

### SSH targets

SSH targets include:

- `ssh://...`.

The built-in read tool already escalates SSH reads to exec-tier approval. The plugin should not weaken that. It can either:

- leave SSH to the built-in approval system; or
- add a second prompt when stricter SSH policy is enabled.

Default: leave SSH unchanged.

## Tool-specific target extraction

### `read`

Input:

```ts
{ path: string }
```

Extract exactly one raw target from `input.path`.

Special cases:

- delimited multi-path reads should be split and classified per target if feasible;
- archive/sqlite selectors should classify the outer local file path;
- URL selectors should classify the URL/scheme before selector parsing.

### `grep`

Inputs may include:

```ts
{ path?: string | string[], paths?: string | string[] }
```

If no path is provided, the implicit path is `.` and should allow because it resolves to cwd.

If multiple paths are provided, classify each path. Prompt if any target requires approval. The prompt should list all restricted targets.

### `glob`

Input:

```ts
{ path?: string }
```

If no path is provided, the implicit path is `.` and should allow.

Glob patterns need base-path extraction before classification:

```text
src/**/*.ts          -> base src
../*/secrets/*.env   -> base ../
~/Documents/**/*.md  -> base ~/Documents
/**/*.txt            -> filesystem root, prompt/block
```

For the first plugin version, conservative classification is acceptable:

- explicit absolute path or `~` path -> prompt unless under cwd;
- relative path that normalizes outside cwd via `..` -> prompt;
- simple relative glob -> allow.

## Prompt UX

When a restricted target is detected, show an extension UI prompt before allowing the tool call.

Example title:

```text
Read target requires approval
```

Example body:

```text
Tool: read
Target: issue://3293
Kind: network
Reason: issue:// is an external resource scheme and is not inside cwd.
```

Options:

- Allow once
- Allow this scope for this session
- Deny

For filesystem targets, session-scope should eventually support path walking:

```text
Requested: /home/user/projects/repo/secret.txt
Grant:     /home/user/projects/repo/secret.txt
← parent:  /home/user/projects/repo/
← parent:  /home/user/projects/
← parent:  /home/user/
← parent:  /
```

The extension UI `select` API supports `onLeft` and `onRight`, so path-walking can be implemented later. The first version may use simpler static options.

For network targets, session-scope should be origin/scheme based:

```text
https://github.com
scheme:issue
scheme:pr
```

## Grants

Maintain in-memory session grants first.

```ts
interface SessionGrantStore {
  filesystemPaths: Set<string>; // realpath prefixes
  networkScopes: Set<string>;   // e.g. origin:https://github.com, scheme:issue
  internalScopes: Set<string>;  // e.g. scheme:artifact
}
```

A grant matches when:

- filesystem target realpath is equal to or inside a granted path;
- network target scope key exactly matches a granted network scope;
- internal target scope key exactly matches a granted internal scope.

Persisted grants are optional for v1. If added, store them in a plugin-specific config file rather than relying on core settings support.

Suggested path:

```text
~/.omp/agent/read-target-guard.yml
```

Possible shape:

```yaml
filesystem:
  allowedPaths: []
network:
  allowedScopes:
    - origin:https://github.com
    - scheme:issue
internal:
  allowedScopes:
    - scheme:artifact
    - scheme:agent
```

## Plugin configuration

Use plugin manifest settings for simple defaults where possible. If structured lists are needed, use the plugin-specific YAML file above.

Suggested settings:

```yaml
mode: prompt # prompt | block | audit
filesystemDefault: prompt
networkDefault: prompt
internalDefault: allow
failClosedWithoutUi: true
scopeRoot: cwd # only cwd for this plugin; repo-root intentionally not default
```

For this user's desired behavior, default config should be:

```yaml
filesystemDefault: prompt
networkDefault: prompt
internalDefault: allow
failClosedWithoutUi: true
scopeRoot: cwd
```

## Failure behavior

Default fail-safe behavior:

- if target classification fails and UI exists -> prompt;
- if target classification fails and UI does not exist -> block;
- if a prompt is required but UI is unavailable -> block;
- if multiple targets are present and any one is denied -> block the whole tool call.

The error should explain exactly which target was blocked and why.

## Audit logging

The plugin should write concise security decisions to the normal logger, not `console.log`.

Events to log:

- restricted target prompted;
- target allowed once;
- target granted for session;
- target denied;
- classification failure.

Do not log file contents or full sensitive path lists beyond the target path already shown to the user.

## Implementation outline

### Files

A standalone local plugin could live outside the repo, but during development use an extension package with roughly this structure:

```text
read-target-guard/
  package.json
  src/
    index.ts
    classifier.ts
    grants.ts
    prompt.ts
    path.ts
    scheme.ts
```

### Extension entrypoint

```ts
export default function activate(pi) {
  const grants = new SessionGrantStore();

  pi.on("tool_call", async (event, ctx) => {
    if (!isCoveredTool(event.toolName)) return;

    const targets = await classifyToolCall(event, ctx.cwd, grants, config);
    const restricted = targets.filter(t => t.decision === "prompt" || t.decision === "block");
    if (restricted.length === 0) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: formatNoUiBlockReason(restricted),
      };
    }

    const decision = await promptForTargets(ctx.ui, event.toolName, restricted, grants);
    if (!decision.allowed) {
      return {
        block: true,
        reason: decision.reason,
      };
    }
  });
}
```

### Classifier tests

High-priority test cases:

- relative file inside cwd allows;
- absolute file inside cwd allows;
- `../sibling` prompts;
- repo sibling prompts even when inside same Git repo;
- `~/.ssh/config` prompts;
- `/etc/hosts` prompts;
- symlink inside cwd pointing outside prompts after realpath;
- missing file outside cwd prompts based on nearest existing parent;
- `https://github.com/...` prompts as network;
- `http://example.com` prompts as network;
- `issue://3293` prompts as network;
- `pr://123` prompts as network;
- `artifact://...` follows internal default;
- `ssh://host/path` leaves built-in exec behavior untouched.

### Extension behavior tests

- allowed target returns no block result;
- denied restricted target returns `{ block: true }`;
- allow-once does not create session grant;
- allow-session creates matching grant;
- no-UI restricted target blocks when `failClosedWithoutUi` is true;
- multi-target grep blocks if one target is denied.

## Limitations of plugin-first approach

The plugin can enforce an additional gate before execution, but it cannot fully replace core approval semantics.

Known limitations:

- built-in approval may auto-approve first, then the plugin prompts afterward;
- prompt UI will be custom extension UI, not the native built-in approval dialog;
- non-tool filesystem reads are not covered;
- bash can still read files if the user approves bash or runs in yolo mode;
- custom tools from other plugins are not covered unless explicitly added;
- classification may be conservative for complex archive/sqlite/glob selectors in v1.

These limitations are acceptable for immediate personal hardening. A core implementation should eventually move the classifier into the built-in approval resolver so the native approval prompt, grant UX, and tool policies are unified.

## Recommended v1 behavior

Implement the plugin with these defaults:

- scope filesystem to `ctx.cwd`, not repo root;
- prompt for filesystem targets outside cwd;
- prompt for `http://`, `https://`, `www.`, `issue://`, and `pr://`;
- allow harness-internal `artifact://`, `agent://`, and `rule://` by default;
- leave `ssh://` to built-in exec approval;
- support allow-once and allow-scope-for-session;
- fail closed when no UI is available;
- cover `read`, `grep`, and `glob` first.

This gives the user the desired local protection quickly while keeping the design aligned with a future core PR for #3293.
