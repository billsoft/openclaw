# CLAUDE.md

始终中文沟通

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Full guidance lives in** **[AGENTS.md](AGENTS.md).** Read it for architecture boundaries, plugin/channel rules, commit workflow, testing policy, and platform notes. What follows is an orientation summary.

## What This Is

**OpenClaw** is a personal AI assistant gateway. It routes messages from many messaging channels (Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Matrix, and many more) to AI model providers, and runs as a local gateway process. The CLI binary is `openclaw`.

## Commands

```bash
pnpm install          # install deps
pnpm openclaw ...     # run CLI (dev, via Bun)
pnpm dev              # same as above
pnpm build            # type-check + full build → dist/
pnpm tsgo             # TypeScript type-check only
pnpm check            # lint + format check (local dev gate; run before commits)
pnpm format:fix       # fix formatting (oxfmt --write)
pnpm test             # run all tests (Vitest)
pnpm test:coverage    # tests with V8 coverage
pnpm test <path> -t "test name"   # run a single scoped test
```

Pre-commit hook: `prek install`. Skipping: `FAST_COMMIT=1 git commit ...` (only when you've verified the touched surface another way).

If `pnpm build` is affected by your change (packaging, lazy-loading boundaries, published surfaces), it **must** pass before pushing `main`.

## Architecture

```
src/
  cli/          # CLI option wiring, progress bars, spinners
  commands/     # individual CLI commands
  channels/     # core channel implementations (Telegram, Discord, Slack, Signal, iMessage, Web/WhatsApp, …)
  routing/      # message routing logic
  plugins/      # plugin discovery, manifest validation, loader, registry
  plugin-sdk/   # PUBLIC plugin contract — the only surface extensions may import
  gateway/      # gateway process + protocol
  gateway/protocol/  # typed control-plane + node wire protocol (schema.ts)
  agents/       # agent runtime, auth profiles, model transport
  acp/          # ACP session/translation layer
  infra/        # shared utilities (format-time, etc.)
  terminal/     # terminal output: table.ts (renderTable), theme.ts, palette.ts
  media/        # media pipeline
  canvas-host/  # A2UI canvas runtime

extensions/     # bundled workspace plugins (each is a self-contained package)
apps/
  ios/          # iOS SwiftUI app
  macos/        # macOS menu-bar app
  android/      # Android app
  shared/       # shared native kit (OpenClawKit)
docs/           # Mintlify docs (docs.openclaw.ai)
scripts/        # build, codegen, tooling scripts
```

## Key Architectural Rules

- **Import boundary**: Extension production code may only import `openclaw/plugin-sdk/*` and local barrels (`api.ts`, `runtime-api.ts`). Never import `src/**` from an extension.
- **Core must stay extension-agnostic**: No hardcoded extension/provider/channel id lists in core. Use manifest metadata, capability registries, or plugin-owned contracts instead.
- **No re-export wrapper files**: Import directly from the original source. Search for existing utilities before creating new ones.
- **Dynamic imports**: Don't mix `await import("x")` and `import ... from "x"` for the same module. Use a `*.runtime.ts` boundary for lazy-loaded code.
- **Prompt-cache stability**: Any code assembling model/tool payloads must produce deterministic ordering.

## Code Conventions

- TypeScript ESM, strict mode. No `any`, no `@ts-nocheck`, no inline lint suppressions without explanation.
- `.js` extensions on cross-package ESM imports.
- Files stay under \~700 LOC; extract helpers when larger.
- Colocated tests: `*.test.ts` beside source; e2e: `*.e2e.test.ts`.
- Use `zod` at external boundaries (config, CLI/JSON output, webhook payloads, API responses).
- Prefer discriminated unions and `Result<T, E>` over freeform strings for runtime branching.
- American spelling in all code, comments, docs, UI strings.
- Product name: **OpenClaw** in headings/docs; `openclaw` for CLI, config keys, paths.

## Utility Locations (do not duplicate)

| Need               | Location                                           |
| ------------------ | -------------------------------------------------- |
| Time formatting    | `src/infra/format-time`                            |
| Tables             | `src/terminal/table.ts` (`renderTable`)            |
| Colors/themes      | `src/terminal/theme.ts`, `src/terminal/palette.ts` |
| Progress/spinners  | `src/cli/progress.ts`                              |
| CLI deps injection | `createDefaultDeps` pattern in `src/cli/`          |

## Commits

Use `scripts/committer "<msg>" <file...>` (not manual `git add`/`git commit`). Commit messages: concise, action-oriented (e.g., `CLI: add verbose flag to send`). Do not push merge commits to `main`; rebase instead.

## Docs (Mintlify)

Internal doc links: root-relative, no `.md` extension (e.g., `[Config](/configuration)`). Anchors on root-relative paths (e.g., `[Hooks](/configuration#hooks)`). README uses absolute `https://docs.openclaw.ai/...` URLs.
