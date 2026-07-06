# Read Target Guard

Oh My Pi extension that prompts before read-like tools access targets outside the current working directory or access network/resource schemes such as `https://`, `issue://`, and `pr://`.

## Defaults

- Filesystem trust root is the current working directory (`ctx.cwd`), not the Git repository root.
- `read`, `grep`, and `glob` calls inside `ctx.cwd` are allowed.
- Filesystem targets outside `ctx.cwd` require approval.
- `http://`, `https://`, `www.`, `issue://`, and `pr://` require approval.
- `artifact://`, `agent://`, and `rule://` are allowed by default.
- `ssh://` remains governed by Oh My Pi's built-in exec-tier approval.
- Restricted calls fail closed when no interactive UI is available.

## Install from a local checkout

```sh
omp plugin link packages/read-target-guard
```

Then start `omp` from the directory you want to trust.
