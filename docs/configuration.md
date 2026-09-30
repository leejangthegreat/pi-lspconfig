# Configuration

pi-lspconfig works with no configuration. Configure it when you want a stricter
type-checking mode, a different server binary, a language that is not built in,
or a server turned off.

## The config file

Create `pi-lspconfig.config.ts` in one of these locations:

| Path | Scope |
| ---- | ----- |
| `<home>/.config/pi-lspconfig/config.ts` | Global, all projects |
| `<home>/.pi/pi-lspconfig.config.ts` | Global, all projects |
| `<cwd>/pi-lspconfig.config.ts` | Project |
| `<cwd>/.pi/pi-lspconfig.config.ts` | Project |

Later entries override earlier ones. `.js`, `.mjs`, and `.cjs` are also
recognised; `.ts` is loaded through jiti, so no build step is needed.

**Project-scoped files are loaded only when the project is trusted.** A config
file is executable code, and a server spec names a binary to spawn. If the
project is not trusted, project files are skipped and the built-in configs are
used; the skip is reported once.

Config files are cached by path and modification time. A file edited between
sessions is re-read at the next session start — including `/reload` — while an
untouched file is not re-transformed. A server whose spec changed is restarted;
one whose spec did not is adopted warm.

## Minimal example

```ts
import { defineConfig } from "pi-lspconfig";

export default defineConfig({
	servers: {
		pyright: {
			settings: { python: { analysis: { typeCheckingMode: "strict" } } },
		},
	},
});
```

`defineConfig` returns its argument unchanged. Its only job is type inference
and editor completion inside the config file.

## Reference

### `servers`

A map of server id to override. An id matching a built-in server merges onto it;
an id that does not match defines a new server, in which case `filetypes` is
required.

```ts
servers: {
  // Override a built-in.
  gopls: { settings: { gopls: { staticcheck: false } } },

  // Define a new server.
  mylang: {
    cmd: ["mylang-ls", "--stdio"],
    filetypes: ["mylang"],
    rootMarkers: [".mylangrc", ".git"],
    singleFileSupport: true,
  },
}
```

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `cmd` | `string[]` or `(ctx) => string[]` | Argv. A function may inspect the resolved root before deciding. |
| `installCommand` | `string` | Shell command that installs the binary. Quoted in the `binary_missing` hint. |
| `filetypes` | `string[]` | LSP `languageId`s to handle. |
| `rootMarkers` | `string[]` | Ordered, highest priority first. |
| `rootDir` | `(file, ctx) => string \| undefined` | Dynamic root detection. Takes precedence over `rootMarkers`. |
| `initOptions` | `object` | Sent as `initializationOptions`. |
| `settings` | `object` | Sent via `workspace/didChangeConfiguration` after `initialized`. |
| `env` | `Record<string, string>` | Extra environment variables, merged over the inherited set (`PATH`, `HOME`, locale, temp, and toolchain locators such as `RUSTUP_HOME` or `GOPATH`). |
| `capabilities` | `object` | Client capability overrides, merged over the defaults. |
| `singleFileSupport` | `boolean` | Whether the server works on a file with no project root. |
| `initializeTimeoutMs` | `number` | Handshake deadline. Defaults to 15000. |
| `docs` | `{ description, url? }` | Documentation metadata. |

### `disabledServers`

Server ids that must never start. Applies to built-ins and to servers you
defined.

```ts
disabledServers: ["gopls"];
```

### `languageIds`

Overrides for the file-extension → LSP `languageId` map. Useful for extensions
that are not registered by default.

```ts
languageIds: { ".mts": "typescript", ".vue": "vue" };
```

### `defaults`

Global defaults applied to every server.

```ts
defaults: { initializeTimeoutMs: 20000, maxResults: 200 };
```

## Merge rules

The user's value always wins. Precisely:

| User value | Result |
| ---------- | ------ |
| Plain object | Merged recursively; the user's keys win, omitted keys survive |
| Array | Replaces the default wholesale |
| Function | Replaces the default; functions are never composed |
| `undefined` | Keeps the default |
| `null` | Deletes the key |

`undefined` and `null` mean different things on purpose: `undefined` is "I did
not set this", `null` is "remove this".

Arrays replacing wholesale is a deliberate departure from nvim-lspconfig, which
merges lists index-by-index — a well-known source of surprises.

### Example

Built-in `pyright`:

```ts
{
  cmd: ["pyright-langserver", "--stdio"],
  filetypes: ["python"],
  rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
  settings: { python: { analysis: { typeCheckingMode: "standard", inlayHints: { variableTypes: true } } } },
}
```

With this override:

```ts
servers: { pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } } }
```

the result keeps `cmd`, `filetypes`, `rootMarkers`, and `inlayHints`, and changes
only `typeCheckingMode`. To drop `inlayHints` entirely, set it to `null`:

```ts
servers: { pyright: { settings: { python: { analysis: { inlayHints: null } } } } }
```

## Relative paths

A config file's own `import` statements resolve relative to the config file.
String paths inside the config — `cmd` entries that name a local script, for
example — resolve relative to the session working directory. Use
`path.resolve` in the config if you need a path relative to the config file
itself.

## Errors

Config problems never stop a session. An unreadable or invalid file produces a
warning naming the file and the failing path, and the session continues with the
built-ins (or with the files that did load).

Common mistakes and what you will see:

| Mistake | Message |
| ------- | ------- |
| `cmd: "pyright-langserver"` | `expected a non-empty string array (or a function) ... Did you mean ["<command>", "--stdio"]?` |
| `rootDir: "./src"` | `expected a function` |
| Misspelled key (`filetype`) | `additionalProperties: unexpected property` |
| New server without `filetypes` | noted at resolution time; the server matches no file |

## Checking your config

```
/lsp-config <server>   # the merged spec for one server
/lsp-list              # every configured server
/lsp-status            # what is actually running
```

Set `--lsp-log debug` to see config loading on stderr.
