# Session Priming

Pre-load example conversations into new sessions to guide model behavior through in-context learning.

> **Note:** Session priming is a **runtime feature** that loads examples into the model's context window. It's not related to fine-tuning (which trains model weights). For building training datasets, see [fine-tuning-datasets.md](fine-tuning-datasets.md).

This guide demonstrates how to use `omp --prime` to pre-load conversation patterns into new sessions.

## What is Session Priming?

Session priming allows you to start a new coding session with pre-loaded conversation examples. This is **in-context learning** (not fine-tuning) - you load examples into the model's context window to guide its behavior for that session.

This is useful when you repeatedly need to demonstrate specific patterns or preferences to the model at runtime.

## Example: Arrow Notation Preference

This example demonstrates teaching the model to use ASCII arrows (`->`, `=>`) instead of LaTeX notation (`\to`, `\Rightarrow`) in code and documentation.

### Creating a Prime File

1. **Have a successful example session:**

```bash
omp "Should I use -> or \to in TypeScript?"
# Model learns through in-context examples...
# ... conversation with tool use, corrections, etc ...
```

2. **Note the session file path** (shown in session info or check `~/.omp/agent/sessions/`)

3. **Optional: Edit the session file** to keep only essential examples

The session file is in JSONL format - each line is a JSON object. The first line is the session header, followed by message entries.

### Using the Prime File

```bash
# Prime a new session with your example conversation
omp --prime ~/.omp/agent/sessions/--Projects-myproject/abc123.jsonl "Fix the arrow notation in auth.ts"
```

The model will:
1. Load the priming conversation into memory
2. Start a **new** session (separate from the prime file)
3. Your first prompt continues with the learned context

## Use Cases

### 1. Tool Usage Patterns

Demonstrate proper tool invocation sequences:
- Multi-step debugging workflows
- Complex refactoring patterns
- Testing strategies

### 2. Code Style Preferences

Establish coding conventions:
- Arrow functions vs regular functions
- Import organization
- Comment style
- Naming conventions

### 3. Domain-Specific Knowledge

Prime with project-specific patterns:
- Architecture decisions
- API usage patterns
- Framework conventions

## Best Practices

1. **Keep it focused:** 5-10 message turns is usually enough
2. **Include tool use:** Show successful tool call sequences
3. **Demonstrate corrections:** Include examples where the model learned from mistakes
4. **Test effectiveness:** Try primed vs non-primed sessions to verify impact

## Difference from Other Options

| Option | Purpose | Modifies Original |
|--------|---------|------------------|
| `--resume` | Continue an existing session | Yes (adds to history) |
| `--prime` | Start new with examples | No (reads only) |
| `--fork` | Copy session to new location | No (creates copy) |

## Storage

Prime files are just regular session files (`.jsonl`). You can:
- Copy them to a dedicated primes directory
- Version control them in your project
- Share them with your team
- Edit them manually to refine examples

Example structure:
```
~/.omp/primes/
  ├── arrow-notation.jsonl
  ├── testing-patterns.jsonl
  └── api-conventions.jsonl
```

Then use with:
```bash
omp --prime ~/.omp/primes/arrow-notation.jsonl "your task here"
```
