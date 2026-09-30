# Integration tests

Spawn `tests/fixtures/fake-lsp-server.mjs`, never a real language server — the
fake is fast, deterministic, and needs no toolchain. Real servers appear only
in `real-servers.test.ts`, gated behind `PI_LSP_REAL=1`:

```bash
PI_LSP_REAL=1 npx vitest run tests/integration/real-servers
```

The real suite uses the tiny projects under `tests/fixtures/real/`, skips a
language whose binary is absent, and fails in CI when one of the four is
missing (a green run must not come from silent skips). `gopls` additionally
needs the `go` toolchain on `PATH` — it shells out to it — so a machine with
`gopls` but no `go` fails rather than skips.

Any test that spawns a process must assert that no PID survives it.

Run with `npx vitest run tests/integration`.
