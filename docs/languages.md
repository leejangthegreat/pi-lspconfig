# Built-in language servers

> Generated from `src/languages/*` by `npm run docs:languages`. Do not edit by hand.

4 servers ship with pi-lspconfig. Each is a declarative spec: a command, the language ids it handles, ordered root markers, and default settings.

None of these binaries are installed for you. Put them on your `PATH`; a missing binary is reported with its install command rather than failing silently.

## `vtsls`

| | |
| --- | --- |
| Command | `vtsls --stdio` |
| Language ids | `javascript`, `javascriptreact`, `typescript`, `typescriptreact` |
| Extensions | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` |
| Root markers | `tsconfig.json`, `jsconfig.json`, `package.json`, `.git` |
| Single-file support | yes |
| Upstream | <https://github.com/yioneko/vtsls> |

Chosen over the bundled `typescript-language-server` because it exposes the richer VS Code feature set — call hierarchy, code actions, and `workspace/executeCommand` refactors — behind a stable stdio entry point.

Install: `npm install -g @vtsls/language-server typescript`

## `pyright`

| | |
| --- | --- |
| Command | `pyright-langserver --stdio` |
| Language ids | `python` |
| Extensions | `.py` `.pyi` |
| Root markers | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`, `.git` |
| Single-file support | yes |
| Upstream | <https://github.com/microsoft/pyright> |

Settings land under `python.analysis.*` because Pyright reads them from the `workspace/didChangeConfiguration` payload rather than from `initializationOptions`.

Install: `npm install -g pyright`

## `rust-analyzer`

| | |
| --- | --- |
| Command | `rust-analyzer` |
| Language ids | `rust` |
| Extensions | `.rs` |
| Root markers | `Cargo.toml`, `Cargo.lock`, `rust-project.json`, `.git` |
| Single-file support | yes |
| Upstream | <https://rust-analyzer.github.io/> |

`rust-project.json` is listed so non-Cargo workspaces (Bazel, Buck) resolve a root too.

Install: `rustup component add rust-analyzer`

## `gopls`

| | |
| --- | --- |
| Command | `gopls` |
| Language ids | `go`, `gomod`, `gowork`, `gotmpl` |
| Extensions | `.go` `.mod` `.work` |
| Root markers | `go.work`, `go.mod`, `go.sum`, `.git` |
| Single-file support | no |
| Upstream | <https://pkg.go.dev/golang.org/x/tools/gopls> |

`go.work` outranks `go.mod` so a multi-module workspace resolves to the workspace root rather than to the first module.

Install: `go install golang.org/x/tools/gopls@latest`

## Adding a server

See [Adding a language server](../AGENTS.md#adding-a-language-server). In short: add `src/languages/<name>.ts`, register it in `BUILTIN_SERVERS`, add any new extensions to `EXTENSION_TO_LANGUAGE_ID`, then run `npm run docs:languages`.
