# Integration tests

Spawn `tests/fixtures/fake-lsp-server.mjs`, never a real language server. Real
servers are gated behind `PI_LSP_REAL=1` in milestone M5.

Any test that spawns a process must assert that no PID survives it.

Run with `npx vitest run tests/integration`.
