#!/usr/bin/env node
/**
 * Fake language server — test double for the LSP client.
 *
 * Scheduled for milestone M1. It must be *configurable*, so tests can drive edge
 * cases without installing a real toolchain. The required knobs, from
 * ROADMAP.md M1:
 *
 *   --position-encoding=utf-16|utf-8|utf-32   advertise this encoding
 *   --sync-kind=0|1|2                         advertise this textDocumentSync.change
 *   --definition=<path>:<line>:<character>    canned `textDocument/definition` result
 *   --diagnostics-on-open                     emit publishDiagnostics after didOpen
 *   --ignore-sigterm                          refuse to exit on SIGTERM
 *   --hang-on-initialize                      never answer `initialize`
 *   --record=<path>                           write received capabilities as JSON
 *
 * It must speak newline-safe LSP framing on stdio (Content-Length headers),
 * answer `initialize`/`shutdown`/`exit`, and implement
 * `textDocument/didOpen|didChange|didClose` plus the navigation requests the
 * tests exercise.
 *
 * Keep it dependency-free: `node:process` and `node:fs` only. It is spawned as a
 * child process by tests, so it must not import from `src/`.
 */

process.stderr.write(
	"fake-lsp-server: not implemented yet (milestone M1 in ROADMAP.md).\n",
);

process.exit(1);
