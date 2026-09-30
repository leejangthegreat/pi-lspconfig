# AGENTS.md

Conventions for working in this repository. Read this before changing code;
read `ROADMAP.md` for what to build and `docs/architecture.md` for why the
layering is what it is.

## What this is

A Pi extension that gives the agent semantic code intelligence through language
servers. It ships built-in server configs, accepts user overrides from a config
file, and exposes everything through two tools: `lsp` and `lsp_diagnostics`.

## Layout

```
src/
  protocol.ts    LSP wire types. Imports nothing.
  types.ts       Public domain types. Imports protocol.ts only.
  util/          Pure helpers. No I/O except util/logger (stderr only).
  languages/     One declarative server spec per file. Imports types.ts only.
  config/        Config schema, loading, and the built-in + user merge.
  core/          The LSP engine. Host-neutral: never imports config/ or pi.
  tools/         Tool definitions. Pure helpers from pi allowed; pi.* is not.
  extension/     The only layer that calls pi.*. Composition root.
  index.ts       Extension factory + public authoring API.
tests/
  unit/          No processes, no sockets.
  integration/   Spawns tests/fixtures/fake-lsp-server.mjs.
  fixtures/      Test doubles and config fixtures.
docs/            Architecture, configuration reference, ADRs.
```

## Non-negotiable rules

1. **Respect the dependency direction.**
   `protocol → types → util → languages → config → core → tools → extension → index`.
   If you need something from a higher layer, invert it: pass the value in.
   `core/` receives a `ServerTable`; it never loads config.

2. **Never start a process, socket, watcher, or timer in the extension
   factory.** Pi loads extensions in invocations that have no session. Start
   resources from `session_start` or lazily from a tool call, and release them
   from an idempotent `session_shutdown`.

3. **Never throw out of `session_start`.** Report through
   `ctx.ui.notify`/`logger` and degrade. A broken config file must not stop a
   session.

4. **The client fleet lives on `globalThis`.** `/reload` re-evaluates this
   module graph with a cold cache. A module-level `Map` silently orphans child
   processes. Use `acquireFleetRegistry` / `releaseFleetRegistry`.

5. **Never write to stdout.** Stdout carries the protocol stream in stdio
   modes. Log through `util/logger.ts`, which writes to stderr.

6. **Positions are 1-based at the tool boundary, 0-based on the wire**, and
   converted through the server's negotiated position encoding. Do not assume
   UTF-16.

7. **Truncate every model-facing result** using Pi's `truncateHead`, and say how
   to narrow the query. An untruncated tool result is a bug.

8. **`details` is always an `LspEnvelope`.** Never `undefined`, never a bare
   array. `status` is the authoritative outcome.

## Adding a language server

1. `src/languages/<name>.ts` exporting one `LspServerSpec`. Declarative data
   only — `cmd` and `rootDir` are the only fields allowed to be functions.
2. Register it in `BUILTIN_SERVERS` (`src/languages/index.ts`).
3. Add new file extensions to `EXTENSION_TO_LANGUAGE_ID`.
4. Run `npm run docs:languages`.

Keep `rootMarkers` ordered highest-priority-first: `go.work` before `go.mod`,
`tsconfig.json` before `package.json`.

## Adding an operation

1. Add the name to `LSP_OPERATIONS` in `src/core/operations.ts`.
2. Classify it in `POSITION_OPERATIONS`, `FILE_OPERATIONS`, or
   `WORKSPACE_OPERATIONS`.
3. Handle it in `executeOperation` and `validateOperationRequest` — the
   exhaustive switch makes this a compile error until you do.
4. Add any new parameters to `LspToolParameters` in `src/tools/schemas.ts`.

## Commands

```bash
npm run typecheck        # tsc --noEmit; run before every commit
npm test                 # vitest run
npm run test:watch
npm run docs:languages   # regenerate docs/languages.md from src/languages/*
```

Requires Node >= 22.19. If your shell's default `node` is older, run these with
a v22+ binary.

## Testing rules

- Unit tests must not spawn processes. Inject a `SpawnFn` instead.
- Integration tests use `tests/fixtures/fake-lsp-server.mjs`. Real language
  servers only appear behind `PI_LSP_REAL=1`.
- Any test that spawns a process must assert no PID survives it.
- A new behaviour needs a test that fails without the change.

## Style

- Tabs for indentation, double quotes, semicolons.
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Relative imports carry the `.ts` extension.
- Prefer plain data and factory functions over classes.
- Document *why*, not *what*. The non-obvious decisions here are all
  constraints: reload semantics, trust gating, process leakage, encoding.

## Current state

The extension adapter, config schema, language catalog, types, engine, and tool
surface are real. Milestones M0, M1, M2, M3, M4, and M5 are complete:

- **M0** — `util/merge.ts`, `config/resolve.ts`, and `config/load.ts`, plus the
  shared constants in `util/defaults.ts` (relocated out of `config/` so `core/`
  never has to import `config/`).
- **M1** — the LSP client: `util/text.ts` position conversion and
  `core/client/{launch,connection,initialize,sync,diagnostics}.ts`, exercised
  against `tests/fixtures/fake-lsp-server.mjs`.
- **M2** — the engine: `util/paths.ts`, `util/root.ts`, `core/workspace.ts`,
  `core/registry.ts`, `core/service.ts` (the `(serverId, root)` client fleet and
  its `globalThis` reload handoff), `core/results.ts`, and the full 18-operation
  `core/operations.ts` dispatch.
- **M3** — the tool surface: `tools/format.ts` renderers and the `lsp` /
  `lsp_diagnostics` execute bodies, `tools/session.ts` (the lazy `ToolSession`
  the tools read on every call), the `tool_result` dirty-marking hook, and the
  four `/lsp-*` command handlers.
- **M4** — lifecycle hardening: the mtime-keyed config cache and trust-skip
  reporting in `config/load.ts`, the reload handoff exercised end to end in
  `tests/integration/lifecycle.test.ts`, and a `session_shutdown` path that
  takes no `ctx`.
- **M5** — real-server smoke tests: `tests/integration/real-servers.test.ts`
  (gated behind `PI_LSP_REAL=1`, per-language skips, a CI-only presence guard,
  and the usual PID sweep) against the fixtures in `tests/fixtures/real/`;
  `.github/workflows/ci.yml` installs the four toolchains. Supporting changes:
  `installCommand` on `LspServerSpec` (quoted in `binary_missing` hints),
  push-only diagnostics — `DEFAULT_CLIENT_CAPABILITIES` no longer advertises
  `textDocument.diagnostic`, which the engine never requests — and toolchain
  locators (`CARGO_HOME`, `RUSTUP_HOME`, `GOPATH`, …) added to
  `INHERITED_ENV_ALLOWLIST`, without which a rustup-proxied `rust-analyzer`
  cannot find its installation.
- **M6** — packaging and docs: `scripts/language-docs.ts` (pure renderer) and
  `scripts/gen-language-docs.mjs` (jiti CLI) generate `docs/languages.md`;
  per-server opt-in `autoInstall` with `core/install.ts` as the injectable shell
  runner; one `binary_missing` notification per server from the `tool_result`
  hook; `repository`/`publishConfig` in `package.json` and the tag-driven
  `.github/workflows/publish.yml` (npm Trusted Publishing, OIDC).

The tools read live session state through `ToolSession`; nothing long-lived is
created before the first tool call. All milestones are complete; new work starts
with a ROADMAP entry.

Do not add features outside the current milestone. When implementing a stub,
delete its `Not implemented` throw and update the milestone table in
`ROADMAP.md`.
