# pi-lspconfig — Roadmap

An agent-executable plan. Each milestone lists deliverables, acceptance
criteria, and the exact command that proves it. Work milestones in order; do not
start `Mn+1` until every acceptance criterion for `Mn` passes.

## Status

| Milestone | Title | Status | Needs a real language server |
| --------- | ----- | ------ | ---------------------------- |
| M0 | Scaffold + config core | ✅ done | no |
| M1 | LSP client against a fake server | ⬜ not started | no |
| M2 | Fleet, roots, operations | ⬜ not started | no |
| M3 | Tool surface + extension wiring | ⬜ not started | no |
| M4 | Lifecycle, reload, trust hardening | ⬜ not started | no |
| M5 | Real-server smoke tests | ⬜ not started | **yes** |
| M6 | Packaging and docs | ⬜ not started | no |

Legend: ⬜ not started · 🟨 in progress · ✅ done

---

## Product goal

Give pi's agent real semantic code intelligence, the way an editor gets it:

1. **Works with no configuration.** TypeScript, Python, Rust, and Go resolve to
   a working language server as soon as the binary is on `PATH`.
2. **Overridable without forking.** A user changes a server's settings, command,
   root markers, or adds a new server from a single config file.
3. **One tool, not eighteen.** The model pays for one tool description and
   learns one input shape.
4. **Honest about failure.** A missing binary, an unsupported capability, and a
   genuine crash produce distinct, actionable results — never a silent empty
   list.

## Non-goals

- Replacing `read`/`grep`/`edit`. LSP answers *semantic* questions; text tools
  answer textual ones.
- Formatting, completion, and linting. These are not model-facing navigation
  problems and belong in a different extension.
- Auto-installing language servers. v1 reports the missing binary and the
  install command; installing toolchains is a supply-chain decision for the
  user.
- A standalone MCP server. The tool schemas are JSON Schema and the results are
  MCP-shaped, so a transport can be added later without redesign.

## Architecture invariants

These are not preferences. Breaking one is a bug.

1. **Dependency direction is one-way:**
   `protocol → types → util → languages → config → core → tools → extension → index`.
   `core/` must never import `config/`; it receives a resolved `ServerTable`.
   `tools/` may import Pi's *pure* helpers but must never call `pi.*`.
   `extension/` is the only layer that touches `ExtensionAPI`/`ExtensionContext`.
2. **The fleet lives on `globalThis`.** `/reload` re-evaluates this module graph
   with an empty cache, so a module-level `Map` would orphan every child
   process. See `FLEET_REGISTRY_KEY` in `src/core/service.ts`.
3. **Nothing long-lived starts in the factory.** Start resources from
   `session_start` or lazily from a tool call; release them from an idempotent
   `session_shutdown`.
4. **`session_start` never throws.** Report and degrade.
5. **Every model-facing result is truncated**, and the truncation message says
   how to narrow the query.
6. **Positions are 1-based at the tool boundary**, 0-based on the wire, and
   converted through the negotiated position encoding — never assumed UTF-16.

---

## M0 — Scaffold + config core

**Deliverables**

- `src/config/resolve.ts`: `resolveConfig`, `resolveLanguageIds`, `mergeServerSpec`.
- `src/util/merge.ts`: `deepMerge`, `isPlainObject`, `collectDeletedKeys`.
- `src/config/load.ts`: `configFileCandidates`, `loadUserConfig`, cache + `invalidateConfigCache`.
- `tests/unit/config/*.test.ts`, `tests/fixtures/config/*`.

**Merge policy** (must be implemented exactly; `docs/configuration.md` documents it)

| User value | Result |
| ---------- | ------ |
| plain object | merged recursively, user keys win |
| array | replaces the default |
| function | replaces the default, never composed |
| `undefined` | keeps the default |
| `null` | deletes the key |

**Acceptance criteria**

- `deepMerge` does not mutate either input.
- Nested objects merge; sibling keys the user omitted survive.
- Arrays replace wholesale (assert the default's extra elements are gone).
- A user `rootDir` function replaces the built-in one rather than wrapping it.
- `null` removes a key; `undefined` leaves it.
- A user entry with a new id becomes a new server; a matching id is merged.
- `disabledServers` entries are absent from `resolveConfig().servers`.
- `languageIds` overrides win over `EXTENSION_TO_LANGUAGE_ID`.
- Loading an invalid config returns `{ ok: false, errors }` and never throws.
- Loading a valid config returns a `ServerTable` containing every built-in.

**Verify**

```bash
npm run typecheck && npx vitest run tests/unit/config
```

**Depends on:** nothing.

---

## M1 — LSP client against a fake server

**Deliverables**

- `src/core/client/launch.ts`: `launchLSP`, `defaultSpawn`, `resolveCommand`, `killProcessTree`.
- `src/core/client/connection.ts`: `createLSPConnection`, `isLSPRequestError`.
- `src/core/client/initialize.ts`: `initializeClient` + the four negotiators.
- `src/core/client/sync.ts`: `createDocumentSynchronizer`, `buildContentChanges`.
- `src/core/client/diagnostics.ts`: `createDiagnosticStore`, `toSeverityLabel`.
- `src/util/text.ts`: `splitLines`, `positionToOffset`, `offsetToPosition`, `clampPosition`.
- `tests/fixtures/fake-lsp-server.mjs`, `tests/integration/fake-server.test.ts`.

**The fake server** is a small Node script speaking LSP over stdio. It must be
configurable so tests can drive edge cases without a real toolchain:

- advertise a chosen `positionEncoding` and `textDocumentSync.change`
- answer `initialize` and record the capabilities it received
- respond to `textDocument/definition` with a canned location
- optionally emit `publishDiagnostics` on `didOpen`
- optionally ignore SIGTERM (to exercise the SIGKILL escalation)
- optionally hang on `initialize` (to exercise the timeout)

**Acceptance criteria**

- Handshake completes; `NegotiatedCapabilities` reports the fake's advertised encoding and sync kind.
- `negotiatePositionEncoding` prefers UTF-16 and falls back when it is absent.
- `negotiateSyncKind` normalises the boolean and object forms of `textDocumentSync`.
- `didOpen` → `didChange` → `didClose` are sent with monotonically increasing versions.
- `buildContentChanges` produces incremental edits for an insertion, and a single full change when the diff is not worth it.
- A `definition` request round-trips and returns the canned location.
- A JSON-RPC error response rejects with an `LSPRequestError` carrying the code.
- `kill()` escalates SIGTERM → SIGKILL after the grace period.
- **No leaked PIDs**: after `shutdown()`, every spawned pid is gone. Assert this explicitly — it is the regression that matters most.
- `positionToOffset`/`offsetToPosition` round-trip for UTF-16, UTF-8, and UTF-32 inputs, including astral-plane characters (emoji, CJK extension B).

**Verify**

```bash
npx vitest run tests/integration/fake-server tests/unit/text
```

**Depends on:** M0 (for `util/merge` conventions and the logger).

---

## M2 — Fleet, roots, operations

**Deliverables**

- `src/util/root.ts`: `findRootWithMarkers`, `findGitAncestor`, `findAncestorWith`, `resolveRootForFile`.
- `src/util/paths.ts`: `uriToPath`, `pathToUri`, `normalizePath`, `isSameOrWithin`, `isWindowsPath`.
- `src/core/workspace.ts`: `computeCeiling`, `createWorkspaceResolver`.
- `src/core/registry.ts`: `createServerResolver`, `extensionOf`, `detectLanguageId`.
- `src/core/service.ts`: `createLSPService`, `getLSPService`, `acquireFleetRegistry`, `releaseFleetRegistry`, `peekFleetRegistry`.
- `src/core/operations.ts`: `executeOperation`, `isLspOperation`, `validateOperationRequest`.

**Acceptance criteria**

- The fleet is keyed by `(serverId, root)`; two files in one project share one process, two projects get two.
- A second `getLSPService` for the same `cwd` returns the same instance.
- `acquireFleetRegistry` adopts services left by a previous generation instead of discarding them.
- `releaseFleetRegistry` with `handoff: true` does **not** kill processes within the grace window; without it, it does.
- Marker priority beats depth: a directory with a lower-priority marker closer to the file loses to a higher-priority marker further up.
- `computeCeiling` clamps a file inside a monorepo package to the repo root, and never escapes the session cwd.
- A stray `$HOME/.git` does not pull the root above the session cwd.
- `detectLanguageId` handles `package.json`, `Cargo.lock`, `foo.test.ts`, and extensionless names.
- `validateOperationRequest` rejects `definition` without a position and without a `symbol`, with a message naming both options.
- `executeOperation` returns `status: "no_server"` for an unhandled extension and `"unsupported"` when the server lacks the capability — it never throws for these.

**Verify**

```bash
npx vitest run tests/unit/core tests/unit/root tests/unit/paths
```

**Depends on:** M1.

---

## M3 — Tool surface + extension wiring

**Deliverables**

- `src/tools/format.ts`: `createEnvelope`, `sortLocations`, `capResults`, `renderLocations`, `renderDiagnostics`, `renderEnvelope`, `truncateForModel`.
- `src/tools/lsp.ts` / `src/tools/lsp-diagnostics.ts`: real `execute` bodies.
- `src/extension/lifecycle.ts`: `startSession`/`endSession` against the real engine.
- `src/extension/register.ts`, `src/extension/commands.ts`: implemented handlers.
- `src/extension/lifecycle.ts`: the `tool_result` hook that marks edited paths dirty.
- `tests/integration/tool.test.ts`.

**Acceptance criteria**

- `lsp` with `operation: "definition"` against the fake server returns a `content[0].text` naming `path:line:character` and a `details` envelope with `status: "success"` and `resultCount: 1`.
- `symbol` + `occurrence` resolves to the same result as an explicit `line`/`character`.
- `lsp_diagnostics` returns errors before warnings, grouped by file.
- A 5,000-location result is truncated to `RESULT_MAX_LINES`, and the text contains a narrowing hint.
- `renderEnvelope` for `status: "binary_missing"` includes the server id and an install hint.
- Every tool result carries a `details` envelope; no code path returns `details: undefined`.
- `/lsp-status`, `/lsp-list`, and `/lsp-config` produce output rather than "not implemented".
- Tool registration happens in the factory; no process is spawned until the first tool call.

**Verify**

```bash
npx vitest run tests/integration/tool
pi -e ./src/index.ts
```

**Depends on:** M2.

---

## M4 — Lifecycle, reload, trust hardening

**Deliverables**

- `src/config/load.ts`: real jiti loading, mtime cache, trust gating.
- `src/core/service.ts`: real `acquireFleetRegistry`/`releaseFleetRegistry` handoff.
- `tests/integration/lifecycle.test.ts`.

**Acceptance criteria**

- Reloading (`session_shutdown{reason:"reload"}` then `session_start{reason:"reload"}`) leaves **zero** orphaned processes and does **not** restart the servers.
- `session_shutdown{reason:"quit"}` stops every process.
- Cleanup is idempotent: calling `endSession` twice is safe.
- A config file changed on disk between sessions is re-read on reload (mtime invalidated).
- With `projectTrusted: false`, `<cwd>/pi-lspconfig.config.ts` is not loaded, and the skip is reported once.
- A config file that throws on import produces a `ConfigLoadError`, and the session still starts with the built-ins.
- No `pi`/`ctx` reference is used after `await ctx.reload()`.

**Verify**

```bash
npx vitest run tests/integration/lifecycle
# then manually: run pi, /reload, and confirm `ps` shows no orphaned servers
```

**Depends on:** M3.

---

## M5 — Real-server smoke tests

**Deliverables**

- `tests/integration/real-servers.test.ts`, gated behind `PI_LSP_REAL=1`.
- `.github/workflows/ci.yml` installing `vtsls`, `pyright`, `rust-analyzer`, `gopls`.

**Acceptance criteria**

- For each of the four languages, a `definition` request on a tiny fixture resolves to the expected file and line.
- For each, `lsp_diagnostics` on a file with a deliberate type error reports at least one `error`.
- When a binary is absent, the result is `status: "binary_missing"` with the install command in `hints` — not a hang and not a crash.
- The suite is skipped, not failed, when `PI_LSP_REAL` is unset.

**Verify**

```bash
PI_LSP_REAL=1 npx vitest run tests/integration/real-servers
```

**Depends on:** M4. **This is the first milestone that needs real toolchains.**

---

## M6 — Packaging and docs

**Deliverables**

- `README.md` install/usage, `docs/` refresh, `examples/` configs.
- `scripts/gen-language-docs.mjs` generating `docs/languages.md` from `src/languages/*`.
- Missing-binary UX: one actionable notification per server, not one per call.
- Opt-in auto-install behind a config key (documented, off by default).

**Acceptance criteria**

- `npm pack --dry-run` includes `src/`, `docs/`, `examples/`, and no test fixtures.
- A consumer project can `pi install ./pi-lspconfig` and get the tools.
- `npm run docs:languages` is idempotent: running it twice produces no diff.
- `docs/languages.md` lists all four servers with command, filetypes, and root markers.
- Enabling `noUnusedParameters` and `noUnusedLocals` in `tsconfig.json` produces zero errors.

**Verify**

```bash
npm run docs:languages && git diff --exit-code docs/languages.md
npm pack --dry-run
```

**Depends on:** M5.

---

## Conventions

### Adding a language server

1. Create `src/languages/<name>.ts` exporting one `LspServerSpec`.
2. Register it in `BUILTIN_SERVERS` in `src/languages/index.ts`.
3. Add any new extensions to `EXTENSION_TO_LANGUAGE_ID`.
4. Add a fixture and a smoke case under `tests/integration/real-servers.test.ts` (M5+).
5. Run `npm run docs:languages`.

A new spec must not introduce a `config/` or `core/` import — `languages/` may
only import from `types.ts` and `protocol.ts`.

### Adding an operation

1. Add the name to `LSP_OPERATIONS` in `src/core/operations.ts`.
2. Classify it in `POSITION_OPERATIONS`, `FILE_OPERATIONS`, or `WORKSPACE_OPERATIONS`.
3. Handle it in `executeOperation` and in `validateOperationRequest`.
4. Add the required parameters to `LspToolParameters` in `src/tools/schemas.ts`.
5. Add a fake-server response and a test.

The `operation` enum in the tool schema derives from `LSP_OPERATIONS`, so it
updates automatically — and the dispatch switch becomes a compile error until
you handle the new case.

### Testing rules

- Unit tests never spawn a process. Use the injected `SpawnFn`.
- Integration tests use `tests/fixtures/fake-lsp-server.mjs`, never a real server.
- Real servers only appear behind `PI_LSP_REAL=1`.
- Any test that spawns must assert no PID survives the test.

### Definition of done

A change is done when: `npm run typecheck` passes, `npx vitest run` passes, new
behaviour has a test that fails without the change, and `docs/` reflects any
user-visible change.
