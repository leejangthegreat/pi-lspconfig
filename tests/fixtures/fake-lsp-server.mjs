#!/usr/bin/env node
/**
 * Fake language server — test double for the LSP client.
 *
 * Configurable so tests can drive edge cases without installing a real
 * toolchain. The knobs, from ROADMAP.md M1:
 *
 *   --position-encoding=utf-16|utf-8|utf-32   advertise this encoding
 *   --sync-kind=0|1|2                         advertise this textDocumentSync.change
 *   --definition=<path>:<line>:<character>    canned `textDocument/definition` result
 *   --diagnostics-on-open                     emit publishDiagnostics after didOpen
 *   --ignore-sigterm                          refuse to exit on SIGTERM
 *   --hang-on-initialize                      never answer `initialize`
 *   --record=<path>                           write received capabilities as JSON
 *   --record-versions=<path>                  append {method, uri, version} per sync event
 *
 * It speaks newline-safe LSP framing on stdio (Content-Length headers), answers
 * `initialize`/`shutdown`/`exit`, and implements
 * `textDocument/didOpen|didChange|didClose` plus `textDocument/definition`.
 *
 * Dependency-free: `node:fs` and `node:url` only. It is spawned as a child
 * process by tests, so it must not import from `src/`.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const options = {
		positionEncoding: undefined,
		syncKind: 1,
		definition: undefined,
		diagnosticsOnOpen: false,
		ignoreSigterm: false,
		hangOnInitialize: false,
		record: undefined,
		recordVersions: undefined,
	};
	for (const arg of argv) {
		if (arg.startsWith("--position-encoding=")) {
			options.positionEncoding = arg.slice("--position-encoding=".length);
		} else if (arg.startsWith("--sync-kind=")) {
			options.syncKind = Number(arg.slice("--sync-kind=".length));
		} else if (arg.startsWith("--definition=")) {
			options.definition = arg.slice("--definition=".length);
		} else if (arg === "--diagnostics-on-open") {
			options.diagnosticsOnOpen = true;
		} else if (arg === "--ignore-sigterm") {
			options.ignoreSigterm = true;
		} else if (arg === "--hang-on-initialize") {
			options.hangOnInitialize = true;
		} else if (arg.startsWith("--record=")) {
			options.record = arg.slice("--record=".length);
		} else if (arg.startsWith("--record-versions=")) {
			options.recordVersions = arg.slice("--record-versions=".length);
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

// Truncate the version log once at startup so each run starts clean.
if (options.recordVersions !== undefined) writeFileSync(options.recordVersions, "");

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	process.stdout.write(Buffer.concat([header, body]));
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
	send({ jsonrpc: "2.0", method, params });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function buildCapabilities() {
	const capabilities = {
		textDocumentSync: { openClose: true, change: options.syncKind },
		definitionProvider: true,
	};
	if (options.positionEncoding !== undefined) {
		capabilities.positionEncoding = options.positionEncoding;
	}
	return capabilities;
}

function parseDefinition(value) {
	const match = /^(.*):(\d+):(\d+)$/.exec(value);
	if (match === null) return undefined;
	return { path: match[1], line: Number(match[2]), character: Number(match[3]) };
}

function buildDefinition() {
	if (options.definition === undefined) return null;
	const parsed = parseDefinition(options.definition);
	if (parsed === undefined) return null;
	return {
		uri: pathToFileURL(parsed.path).href,
		range: {
			start: { line: parsed.line, character: parsed.character },
			end: { line: parsed.line, character: parsed.character + 1 },
		},
	};
}

function publishDiagnostics(uri) {
	notify("textDocument/publishDiagnostics", {
		uri,
		diagnostics: [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				severity: 1,
				code: "fake-error",
				source: "fake-lsp",
				message: "fake diagnostic",
			},
		],
	});
}

function recordVersion(entry) {
	if (options.recordVersions === undefined) return;
	// Synchronous on purpose: SIGKILL (the escalation path under test) bypasses
	// any exit handler, so buffered writes would be lost.
	appendFileSync(options.recordVersions, `${JSON.stringify(entry)}\n`);
}

function handle(message) {
	const { id, method, params } = message;
	const isRequest = id !== undefined && id !== null;

	switch (method) {
		case "initialize":
			if (options.hangOnInitialize) return; // Deliberately never answer.
			if (options.record !== undefined) {
				writeFileSync(options.record, JSON.stringify(params ?? null));
			}
			respond(id, { capabilities: buildCapabilities() });
			return;

		case "initialized":
			return;

		case "shutdown":
			respond(id, null);
			return;

		case "exit":
			process.exit(0);
			return;

		case "textDocument/didOpen": {
			const document = params?.textDocument;
			recordVersion({ method, uri: document?.uri, version: document?.version });
			if (options.diagnosticsOnOpen && document?.uri !== undefined) {
				publishDiagnostics(document.uri);
			}
			return;
		}

		case "textDocument/didChange": {
			const document = params?.textDocument;
			recordVersion({ method, uri: document?.uri, version: document?.version });
			return;
		}

		case "textDocument/didClose": {
			recordVersion({ method, uri: params?.textDocument?.uri });
			return;
		}

		case "textDocument/definition":
			respond(id, buildDefinition());
			return;

		default:
			if (isRequest) respondError(id, -32601, `Method not found: ${method}`);
			return;
	}
}

// ---------------------------------------------------------------------------
// stdin pump
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;

		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (match === null) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}

		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return; // Wait for the rest.

		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);

		try {
			handle(JSON.parse(body));
		} catch {
			// Ignore malformed frames rather than crashing the fixture.
		}
	}
});

process.stdin.on("end", () => process.exit(0));

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => {
	// When asked to ignore SIGTERM the process simply stays alive, which is what
	// lets tests observe the client's SIGKILL escalation. Only SIGKILL ends it.
	if (options.ignoreSigterm) return;
	process.exit(0);
});
