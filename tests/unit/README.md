# Unit tests

No processes, no sockets, no real language servers. Inject a `SpawnFn` when a
test needs a client. Scheduled in milestones M0–M4 of `ROADMAP.md`.

Run with `npx vitest run tests/unit`.
