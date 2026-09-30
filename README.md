# pi-lspconfig

Language Server Protocol support for [pi](https://pi.dev) — out-of-the-box LSP
configs for common languages, overridable from a single config file, exposed
through one unified tool.

Built on nvim-lspconfig's config model and pi-lens's tool surface.

> **Status: usable.** Milestones M0–M3 are complete: the tools, diagnostics,
> and `/lsp-*` commands are live. Lifecycle/reload hardening (M4), real-server
> smoke tests (M5), and packaging (M6) remain — see [`ROADMAP.md`](ROADMAP.md).

## Why

An agent that only has `grep` cannot tell a function's definition from a mention
in a comment, a string, or an unrelated same-named symbol. A language server can.
This extension puts one in reach of the model without asking the user to
configure anything.

## Design

**Built-in configs, overridable.** Each supported language ships a declarative
server spec — command, language ids, root markers, settings — in the spirit of
nvim-lspconfig's server tables. A `pi-lspconfig.config.ts` file deep-merges over
them, and the user's value always wins.

**One tool, not eighteen.** `definition`, `references`, `hover`,
`documentSymbol`, `workspaceSymbol`, `codeAction`, `rename`, and the call
hierarchy are all operations of a single `lsp` tool. The model learns one input
shape and pays for one tool description.

**Honest failure.** A missing binary, an unsupported capability, and a real
crash return distinct statuses with actionable hints — never a silent empty
list.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `lsp` | Navigation, symbols, hover, code actions, rename, call hierarchy |
| `lsp_diagnostics` | Errors and warnings for a file or the workspace |

`lsp` takes `path` plus either a 1-based `line`/`character` or a `symbol` name —
naming the symbol is usually more reliable than guessing a column.

## Configuration

Create `pi-lspconfig.config.ts` in your project root (or `~/.pi/` for all
projects):

```ts
import { defineConfig } from "pi-lspconfig";

export default defineConfig({
	servers: {
		// Override a built-in server.
		pyright: {
			settings: { python: { analysis: { typeCheckingMode: "strict" } } },
		},
		// Add a server that is not built in.
		mylang: {
			cmd: ["mylang-ls", "--stdio"],
			filetypes: ["mylang"],
			rootMarkers: [".mylangrc", ".git"],
		},
	},
	disabledServers: ["gopls"],
});
```

Override rules: objects merge recursively with the user's keys winning; arrays
and functions replace the default; `undefined` keeps the default; `null` deletes
the key.

See [`docs/configuration.md`](docs/configuration.md) for search paths,
precedence, and the full reference.

## Commands

| Command | Purpose |
| ------- | ------- |
| `/lsp-status` | Running servers, roots, and diagnostic counts |
| `/lsp-restart [server]` | Restart one server, or all of them |
| `/lsp-list` | Configured servers |
| `/lsp-config <server>` | Resolved spec for one server |

## Flags

| Flag | Purpose |
| ---- | ------- |
| `--lsp-disable` | Turn the extension off for one invocation |
| `--lsp-log <level>` | stderr log level: `off`, `error`, `warn`, `info`, `debug`, `verbose` |

## Install

```bash
pi install npm:pi-lspconfig
```

During development:

```bash
npm install
pi -e ./src/index.ts
```

Language servers are **not** installed for you. Put `vtsls`, `pyright-langserver`,
`rust-analyzer`, or `gopls` on your `PATH` as needed; a missing binary is
reported with its install command.

## Supported languages

TypeScript/JavaScript (`vtsls`), Python (`pyright`), Rust (`rust-analyzer`), and
Go (`gopls`). See [`docs/languages.md`](docs/languages.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — layers, lifecycle, and the two
  invariants that are easy to get wrong
- [`docs/configuration.md`](docs/configuration.md) — config reference
- [`docs/languages.md`](docs/languages.md) — built-in servers
- [`docs/adr/`](docs/adr/) — decision records
- [`ROADMAP.md`](ROADMAP.md) — milestones
- [`AGENTS.md`](AGENTS.md) — conventions for contributors and agents

## Development

```bash
npm run typecheck
npm test
```

Requires Node >= 22.19.

## License

MIT
