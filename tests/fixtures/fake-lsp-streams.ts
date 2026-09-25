/**
 * In-process LSP server double.
 *
 * Unit tests must not spawn processes, but the fleet still needs a *real*
 * JSON-RPC handshake to exercise: `createLSPService` calls
 * `createLSPConnection`, `initializeClient`, and the document synchroniser, all
 * of which speak over streams. This fixture supplies a `SpawnFn` that returns a
 * fake `LSPProcess` whose stdio is a pair of in-memory `PassThrough`s, with a
 * second `vscode-jsonrpc` connection answering on the far end.
 *
 * Two one-way pipes, not one duplex: `toServer` is written by the client and
 * read by the server, `toClient` the other way. A single duplex would echo the
 * client's own messages back at it.
 *
 * Specs must set `cmd[0]` to an absolute executable (use `process.execPath`):
 * `createLSPService` calls `resolveCommand` before spawning, so a made-up
 * binary name would be reported as `binary_missing` and the fake never reached.
 */

import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
	NullLogger,
	StreamMessageReader,
	StreamMessageWriter,
	createMessageConnection,
} from "vscode-jsonrpc/node";
import type { LSPProcess, SpawnFn, SpawnSpec } from "../../src/core/client/launch.ts";
import type { ServerCapabilities } from "../../src/protocol.ts";

/** One fake server, as seen by the test. */
export interface FakeServer {
	spec: SpawnSpec;
	/** Requests the client sent, in arrival order. */
	requests: { method: string; params: unknown }[];
	/** Notifications the client sent, in arrival order. */
	notifications: { method: string; params: unknown }[];
	capabilities: ServerCapabilities;
	/** True once `kill()` has run (or the client sent `exit`). */
	readonly killed: boolean;
	kill(): void;
}

export interface FakeSpawn {
	spawn: SpawnFn;
	/** Every spawn spec, in call order. */
	spawned: SpawnSpec[];
	/** One entry per spawned fake server. */
	servers: FakeServer[];
}

export interface FakeSpawnOptions {
	/** Capabilities the fake advertises. */
	capabilities?: ServerCapabilities;
	/** Never answer `initialize`, to exercise the handshake timeout. */
	hangOnInitialize?: boolean;
	/** Extra request handlers, keyed by LSP method. */
	handlers?: Record<string, (params: unknown) => unknown>;
}

const DEFAULT_CAPABILITIES: ServerCapabilities = {
	textDocumentSync: { openClose: true, change: 1 },
	definitionProvider: true,
	hoverProvider: true,
	documentSymbolProvider: true,
	workspaceSymbolProvider: true,
	referencesProvider: true,
	callHierarchyProvider: true,
	executeCommandProvider: { commands: ["fake.command"] },
};

/** Build a `SpawnFn` plus the bookkeeping tests assert against. */
export function createFakeSpawn(options: FakeSpawnOptions = {}): FakeSpawn {
	const spawned: SpawnSpec[] = [];
	const servers: FakeServer[] = [];
	const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;

	const spawn: SpawnFn = (spec) => {
		spawned.push(spec);

		const toServer = new PassThrough();
		const toClient = new PassThrough();
		const connection = createMessageConnection(
			new StreamMessageReader(toServer),
			new StreamMessageWriter(toClient),
			NullLogger,
		);

		let settleExited!: (code: number | null) => void;
		const exited = new Promise<number | null>((resolve) => {
			settleExited = resolve;
		});

		let killed = false;
		const kill = (): void => {
			if (killed) return;
			killed = true;
			try {
				connection.dispose();
			} catch {
				// Already disposed.
			}
			toServer.end();
			toClient.end();
			settleExited(0);
		};

		const server: FakeServer = {
			spec,
			requests: [],
			notifications: [],
			capabilities,
			get killed() {
				return killed;
			},
			kill,
		};
		servers.push(server);

		connection.onRequest("initialize", (params) => {
			if (options.hangOnInitialize === true) return new Promise(() => {});
			server.requests.push({ method: "initialize", params });
			return { capabilities };
		});
		connection.onRequest("shutdown", () => null);
		connection.onNotification("exit", () => kill());

		for (const method of [
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didClose",
		]) {
			connection.onNotification(method, (params) => {
				server.notifications.push({ method, params });
			});
		}

		connection.onRequest("textDocument/definition", (params) => {
			server.requests.push({ method: "textDocument/definition", params });
			return null;
		});

		for (const [method, handler] of Object.entries(options.handlers ?? {})) {
			connection.onRequest(method, (params) => {
				server.requests.push({ method, params });
				return handler(params);
			});
		}

		connection.listen();

		const process: LSPProcess = {
			// `createLSPConnection` reads only `stdout` and `stdin`.
			child: {
				stdout: toClient,
				stdin: toServer,
				stderr: new PassThrough(),
			} as unknown as ChildProcessWithoutNullStreams,
			pid: undefined,
			command: spec.command,
			args: spec.args,
			exited,
			kill: async () => {
				kill();
			},
		};
		return process;
	};

	return { spawn, spawned, servers };
}

/** Wait for `ms`. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
