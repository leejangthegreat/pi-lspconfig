/**
 * JSON-RPC connection over a language server's stdio.
 *
 * The framing (`Content-Length` headers) is handled by `vscode-jsonrpc`'s
 * `StreamMessageReader`/`StreamMessageWriter`; this module is the thin adapter
 * that turns them into a typed request/notification surface and tracks
 * in-flight requests for cancellation.
 */

import type { MessageConnection } from "vscode-jsonrpc/node";
import type { LSPProcess } from "./launch.ts";

export interface Disposable {
	dispose(): void;
}

export interface LSPConnection {
	/** The underlying `vscode-jsonrpc` connection, for escape hatches. */
	readonly raw: MessageConnection;
	/** Send a request. Rejects with an `LSPRequestError` on a JSON-RPC error response. */
	sendRequest<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R>;
	/** Send a notification (fire and forget). */
	sendNotification(method: string, params: unknown): void;
	/** Subscribe to a server → client notification. */
	onNotification(method: string, handler: (params: unknown) => void): Disposable;
	/** Register a client → server request handler (e.g. `workspace/configuration`). */
	onRequest<R>(method: string, handler: (params: unknown) => R | Promise<R>): Disposable;
	/** Begin reading from the streams. Must be called before any request. */
	listen(): void;
	/** Cancel every in-flight request. Used on shutdown. */
	cancelAll(): void;
	/** Tear down listeners. Does not kill the process. */
	dispose(): void;
}

export interface LSPRequestError extends Error {
	code: number;
	data?: unknown;
}

/** True for a JSON-RPC error thrown by `sendRequest`. */
export function isLSPRequestError(_error: unknown): _error is LSPRequestError {
	throw new Error("Not implemented: isLSPRequestError");
}

/** Create a connection bound to a spawned server's stdio. */
export function createLSPConnection(_process: LSPProcess): LSPConnection {
	throw new Error("Not implemented: createLSPConnection");
}
