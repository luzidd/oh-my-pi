# Scripts

Utility scripts for oh-my-pi development and dataset creation.

## Fine-Tuning Dataset Tools

Build training datasets from your oh-my-pi sessions:

- **[rate-sessions.py](rate-sessions.py)** - Batch rating tool for existing sessions
- **[convert-to-training-format.py](convert-to-training-format.py)** - Convert rated turns to SFT/DPO formats

See [docs/fine-tuning-datasets.md](../docs/fine-tuning-datasets.md) for full documentation.

## Development Tools

- **[analyze_small_edits.py](analyze_small_edits.py)** - Analyze edit performance
- **[bench-edit-hashline-sep.ts](bench-edit-hashline-sep.ts)** - Benchmark hashline separators
- **[check-spoofed-versions.ts](check-spoofed-versions.ts)** - Version validation
- **[ci-build-native.ts](ci-build-native.ts)** - CI native build script
- **[ci-release-build-binaries.ts](ci-release-build-binaries.ts)** - Release binary builder
- **[ci-release-publish.ts](ci-release-publish.ts)** - Release publisher
- And more...

Most development scripts are TypeScript and run with Bun. Analysis scripts use Python.
