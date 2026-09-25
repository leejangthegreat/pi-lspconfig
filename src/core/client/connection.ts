/**
 * JSON-RPC connection over a language server's stdio.
 *
 * The framing (`Content-Length` headers) is handled by `vscode-jsonrpc`'s
 * `StreamMessageReader`/`StreamMessageWriter`; this module is the thin adapter
 * that turns them into a typed request/notification surface and tracks
 * in-flight requests for cancellation.
 */

import {
	CancellationTokenSource,
	ConnectionError,
	NullLogger,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
	createMessageConnection,
} from "vscode-jsonrpc/node";
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

/**
 * True for a JSON-RPC error thrown by `sendRequest`.
 *
 * `ResponseError` is the class `vscode-jsonrpc` rejects with, so the identity
 * check is the precise one. `ConnectionError` also carries a numeric `code`
 * but means the transport died, not that the server answered with an error, so
 * it is excluded before the structural fallback (which exists only to tolerate
 * a second copy of the library).
 */
export function isLSPRequestError(error: unknown): error is LSPRequestError {
	if (error instanceof ResponseError) return true;
	if (error instanceof ConnectionError) return false;
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as { code?: unknown }).code === "number" &&
		typeof (error as { message?: unknown }).message === "string"
	);
}

/** A request that is still awaiting a response, kept so `cancelAll` can settle it. */
interface PendingRequest {
	source: CancellationTokenSource;
	reject(error: unknown): void;
}

/** Create a connection bound to a spawned server's stdio. */
export function createLSPConnection(process: LSPProcess): LSPConnection {
	const reader = new StreamMessageReader(process.child.stdout);
	const writer = new StreamMessageWriter(process.child.stdin);
	const raw = createMessageConnection(reader, writer, NullLogger);
	const pending = new Set<PendingRequest>();

	const sendRequest = <R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> => {
		if (signal?.aborted) return Promise.reject(abortReason(signal));

		return new Promise<R>((resolve, reject) => {
			const source = new CancellationTokenSource();
			const entry: PendingRequest = { source, reject };
			pending.add(entry);

			const onAbort = (): void => {
				source.cancel();
				reject(abortReason(signal as AbortSignal));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const cleanup = (): void => {
				pending.delete(entry);
				source.dispose();
				signal?.removeEventListener("abort", onAbort);
			};

			// `vscode-jsonrpc` cancellation only emits `$/cancelRequest`; it never
			// settles the promise on its own. The abort listener above is what
			// actually rejects, so the two must be kept together.
			raw.sendRequest<R>(method, params, source.token).then(
				(value) => {
					cleanup();
					resolve(value);
				},
				(error: unknown) => {
					cleanup();
					reject(error);
				},
			);
		});
	};

	const cancelAll = (): void => {
		for (const entry of [...pending]) {
			entry.source.cancel();
			entry.reject(new Error("Request cancelled"));
		}
		pending.clear();
	};

	return {
		raw,
		sendRequest,
		sendNotification: (method, params) => {
			// Fire and forget: a write after the stream closes must not surface as
			// an unhandled rejection.
			void raw.sendNotification(method, params).catch(() => {});
		},
		onNotification: (method, handler) => raw.onNotification(method, handler),
		// `vscode-jsonrpc` types its generic handler as returning `HandlerResult`,
		// which cannot be expressed through our narrower `R | Promise<R>` shape.
		onRequest: <R>(method: string, handler: (params: unknown) => R | Promise<R>) =>
			raw.onRequest(method, handler as never),
		listen: () => raw.listen(),
		cancelAll,
		dispose: () => {
			cancelAll();
			raw.dispose();
		},
	};
}

/** Turn an `AbortSignal` into the error to reject with. */
function abortReason(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" ? reason : "Request aborted");
	error.name = "AbortError";
	return error;
}
