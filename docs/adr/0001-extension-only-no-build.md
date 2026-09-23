# ADR 0001 — Extension only, no build step

- **Status:** accepted
- **Date:** 2026-09-23

## Context

pi-lspconfig needs to be delivered in a form Pi can load, and its source needs to
be consumable by a TypeScript config file (`pi-lspconfig.config.ts`) that users
author.

Two delivery shapes were considered, and two build strategies.

### Delivery

1. **A Pi extension that registers tools directly**, plus an optional standalone
   MCP server binary.
2. **A Pi extension only.**
3. **An MCP server only**, consumed through a third-party MCP adapter extension.

Pi's Extensions API has no built-in MCP registration — MCP support in Pi comes
from adapter extensions (`pi-mcp-adapter`, `pi-codemcp`) that read `mcpServers`
configuration. Option 1 would therefore mean shipping and maintaining a second
entry point and a hand-rolled JSON-RPC transport for a capability Pi does not
consume natively.

### Build

1. **Ship compiled `dist/`**, as pi-lens does (`tsc` + a bundler, with `bin`
   entries for the MCP servers).
2. **Ship TypeScript source**, loaded by jiti, with `tsc --noEmit` for checking
   only.

Pi loads extensions through jiti and documents that local TypeScript extensions
need no compilation step. Pi also supplies `typebox` and
`@earendil-works/pi-coding-agent` as peer packages, and virtualises them in
bundled builds.

## Decision

**Option 2: extension only. Ship TypeScript source.**

`package.json` declares:

```json
{
	"pi": { "extensions": ["./src/index.ts"] },
	"exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}
```

The unified interface is still "MCP-shaped": tool parameters are plain JSON
Schema (produced by TypeBox) and results are `{ content, details }`. A future MCP
transport can reuse both without redesign — it would add a transport, not
restructure the tool layer.

## Consequences

**Positive**

- One entry point, one artifact. No build step, no `dist/` drift, no bundler
  configuration.
- The config authoring API and the runtime are the same files, so a config's
  types always match the installed code.
- Tool schemas and result shapes stay transport-agnostic by construction.

**Negative**

- Consumers importing the package's types need `moduleResolution: "bundler"` or
  `"nodenext"`; extensionless/`.ts` entry points are not resolvable under the
  legacy `"node"` resolver.
- No compiled artifact means no `bin` entry point, so an MCP server would require
  reintroducing a build step.
- `npm pack` ships TypeScript source, which is larger than compiled JavaScript.
  Acceptable at this size.

**Neutral**

- Pi's virtual-module map constrains which Pi packages may be imported. Notably
  `@earendil-works/pi-ai/utils/*` is *not* virtualised, so the documented
  `StringEnum` helper is unreachable in bundled builds. `src/tools/schemas.ts`
  therefore carries a three-line local equivalent. If Pi later virtualises that
  subpath, the local helper can be deleted.
