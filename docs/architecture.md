# Architecture

## Layering

Dependencies point one way, without exception:

```
protocol.ts → types.ts → util/ → languages/ → config/ → core/ → tools/ → extension/ → index.ts
```

| Layer | May import | Must not import | Why it exists |
| ----- | ---------- | --------------- | ------------- |
| `protocol.ts` | nothing | everything | LSP wire types. A hand-maintained subset of the spec. |
| `types.ts` | `protocol.ts` | everything else | Public domain types: server specs, envelopes, statuses. |
| `util/` | `types.ts` | `core/`, `tools/`, `extension/` | Pure helpers. Only `logger.ts` does I/O, and only to stderr. |
| `languages/` | `types.ts`, `protocol.ts` | `config/`, `core/` | One declarative server spec per file. Data, not behaviour. |
| `config/` | `types.ts`, `languages/`, `util/` | `core/`, `tools/` | Schema, loading, and the built-in + user merge. |
| `core/` | `types.ts`, `protocol.ts`, `util/` | **`config/`**, `tools/`, `extension/` | The LSP engine. Host-neutral and injectable. |
| `tools/` | `core/`, `config/` (defaults), `util/`, Pi *pure* helpers | `extension/`, `pi.*` calls | Tool definitions. |
| `extension/` | everything | — | The only layer that calls `pi.*`. Composition root. |
| `index.ts` | `extension/`, plus public re-exports | — | Extension factory and authoring API. |

Two rules are worth stating explicitly because they are load-bearing:

**`core/` never imports `config/`.** `LSPService` takes a resolved `ServerTable`
and a `SpawnFn` in its constructor. This keeps the engine free of config-loading
concerns, makes it constructible with a two-entry table in a unit test, and
avoids a `config → languages → core → config` cycle the moment anything needs a
default.

**`tools/` never calls `pi.*`.** It may import Pi's pure helpers (`defineTool`,
`Type`, `truncateHead`) and type-only declarations, because those erase at
runtime. It must not touch `ExtensionAPI` or `ExtensionContext` as values. The
extension layer injects a `getService(cwd)` resolver instead, so tool `execute`
bodies are testable with a plain stub.

## Runtime lifecycle

```
pi starts
  │
  ├─ factory(pi)                       ← declarations only
  │    registerFlag × 2
  │    on(session_start | session_shutdown | resources_discover | tool_result)
  │    registerTool(lsp), registerTool(lsp_diagnostics)
  │    registerCommand × 4
  │
  ├─ session_start
  │    refreshFlags()                  ← CLI values are bound only after load
  │    loadUserConfig()                ← trust-gated, never throws
  │    resolveConfig()  → ServerTable
  │    acquireFleetRegistry()          ← adopts a surviving fleet on reload
  │    getLSPService()
  │
  ├─ tool call: lsp / lsp_diagnostics
  │    resolveServerResolver(path)
  │    workspace.resolve(spec, file)   ← starts the client on first use
  │    executeOperation() → LspEnvelope
  │
  └─ session_shutdown
       releaseFleetRegistry(handoff = reason === "reload")
```

### Why the factory starts nothing

Pi loads extensions in invocations that never start a session — `--list-models`,
config inspection, RPC entry points. Starting a language server from the factory
would spawn processes for all of them. Everything long-lived starts in
`session_start` or lazily from a tool call.

### Why flags are read at `session_start`

Command-line flag values are bound *after* every extension finishes loading, so
`pi.getFlag()` in the factory always returns the registered default.
`refreshFlags()` re-reads them at `session_start` and rebuilds the logger.

### Why config is loaded at `session_start`

The factory always runs before project trust is resolved, so
`ctx.isProjectTrusted()` is `false` there. Config files are executable code, and
a server spec can name an arbitrary binary to spawn — that is the feature, which
is exactly why project-scoped files are gated on trust.

## The fleet and `/reload`

`/reload` clears the jiti module cache and re-evaluates this whole module graph.
Two consequences drive the design:

1. **A module-level `Map` would be rebuilt**, orphaning every previously spawned
   language server. The fleet is therefore anchored to
   `globalThis[Symbol.for("pi-lspconfig.fleet")]`.
2. **Shutdown and startup race.** The old runtime gets
   `session_shutdown{reason:"reload"}`; the new one gets
   `session_start{reason:"reload"}`. Hard-killing on shutdown would discard every
   warm server and can interrupt an `initialize` the successor already started.
   So `releaseFleetRegistry(..., { handoff: true })` defers teardown by a grace
   window; a successor that claims the registry makes the deferred teardown a
   no-op.

After `await ctx.reload()` the old `pi`/`ctx` throw on use. Nothing may hold a
reference across a reload.

## Position handling

Three coordinate systems meet here, and mixing them is the most common source of
silently wrong results:

| System | Base | Unit |
| ------ | ---- | ---- |
| Tool input | 1-based | whatever the model read from a file or compiler |
| LSP wire | 0-based | code units in the **negotiated** encoding |
| JavaScript string | 0-based | UTF-16 code units |

`util/text.ts` owns the conversions. The negotiated encoding is captured once per
client in `NegotiatedCapabilities` — never assumed to be UTF-16, even though
UTF-16 wins whenever a server offers it.

## Diagnostics

Diagnostics are push-first: the server sends `textDocument/publishDiagnostics`
whenever it likes. That makes "give me diagnostics right after this edit" racy —
the server has not finished re-analysing.

`DiagnosticStore.waitFor()` resolves after a quiet window with no new publish, so
results reflect the current file rather than the previous revision. Servers that
advertise `diagnosticProvider` are polled opportunistically, but push remains the
primary path.

## Tool results

Every result has two halves:

- `content[0].text` — compact prose for the model, truncated with
  `truncateHead`, always followed by a hint explaining how to narrow the query.
- `details` — an `LspEnvelope` with a machine-stable `status`, `resultCount`, and
  the structured payload.

`status` is authoritative. A tool that returns an empty list because the server
is missing must say `binary_missing`, not look like a successful empty search.
