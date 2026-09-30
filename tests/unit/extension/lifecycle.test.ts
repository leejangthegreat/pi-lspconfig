import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionState, installLifecycle, type SessionState } from "../../../src/extension/lifecycle.ts";
import { createServiceStub } from "../tools/service-stub.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A `pi` that records event handlers instead of dispatching them. */
function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

/** Install the lifecycle handlers and hand back the `tool_result` one. */
function toolResultHandler(state: SessionState): Handler {
	const { pi, handlers } = fakePi();
	installLifecycle(pi, state);
	const handler = handlers.get("tool_result");
	if (handler === undefined) throw new Error("tool_result handler was not installed");
	return handler;
}

function resultEvent(toolName: string, input: Record<string, unknown>, isError = false): unknown {
	return { type: "tool_result", toolName, toolCallId: "call-1", input, content: [], isError };
}

/** A tool result carrying an LSP envelope in `details`. */
function envelopeEvent(toolName: string, details: unknown): unknown {
	return { ...(resultEvent(toolName, {}) as object), details };
}

/** A context that records `ui.notify` calls. */
function uiContext() {
	const notifications: { message: string; level: string }[] = [];
	return {
		ctx: {
			cwd: "/repo",
			hasUI: true,
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		},
		notifications,
	};
}

const CTX = { cwd: "/repo", hasUI: false };

describe("tool_result hook", () => {
	it("marks an edited file dirty, resolved against the cwd", () => {
		const state = createSessionState();
		const stub = createServiceStub();
		state.service = stub.service;

		toolResultHandler(state)(resultEvent("edit", { path: "src/a.ts" }), CTX);

		expect(stub.dirty).toEqual(["/repo/src/a.ts"]);
	});

	it("marks a written file dirty", () => {
		const state = createSessionState();
		const stub = createServiceStub();
		state.service = stub.service;

		toolResultHandler(state)(resultEvent("write", { path: "src/b.ts", content: "x" }), CTX);

		expect(stub.dirty).toEqual(["/repo/src/b.ts"]);
	});

	it("ignores a failed edit, other tools, and a missing path", () => {
		const state = createSessionState();
		const stub = createServiceStub();
		state.service = stub.service;
		const handler = toolResultHandler(state);

		handler(resultEvent("edit", { path: "src/a.ts" }, true), CTX);
		handler(resultEvent("bash", { command: "rm src/a.ts" }), CTX);
		handler(resultEvent("read", { path: "src/a.ts" }), CTX);
		handler(resultEvent("edit", {}), CTX);
		handler(resultEvent("edit", { path: 42 }), CTX);
		handler(resultEvent("edit", { path: "" }), CTX);

		expect(stub.dirty).toEqual([]);
	});

	it("does nothing, and does not throw, without a service", () => {
		const state = createSessionState();

		expect(() => toolResultHandler(state)(resultEvent("edit", { path: "src/a.ts" }), CTX)).not.toThrow();
	});

	it("swallows a throwing markDirty", () => {
		const state = createSessionState();
		const stub = createServiceStub();
		state.service = {
			...stub.service,
			markDirty: () => {
				throw new Error("boom");
			},
		};

		expect(() => toolResultHandler(state)(resultEvent("edit", { path: "src/a.ts" }), CTX)).not.toThrow();
	});
});

describe("binary_missing notifications", () => {
	function envelope(serverId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			operation: "lsp",
			ok: false,
			status: "binary_missing",
			resultCount: 0,
			servers: [serverId],
			hints: [
				`Install it with: npm install -g ${serverId}`,
				`Or override 'cmd' for '${serverId}' in pi-lspconfig.config.ts.`,
			],
			...extra,
		};
	}

	it("notifies once per server, quoting the install command", () => {
		const state = createSessionState();
		const handler = toolResultHandler(state);
		const { ctx, notifications } = uiContext();

		handler(envelopeEvent("lsp", envelope("pyright")), ctx);
		handler(envelopeEvent("lsp_diagnostics", envelope("pyright")), ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.message).toContain("pi-lspconfig: pyright is not installed.");
		expect(notifications[0]?.message).toContain("Install it with: npm install -g pyright");
		expect(notifications[0]?.level).toBe("warning");

		// A second server is a separate notification, not a suppression.
		handler(envelopeEvent("lsp", envelope("gopls")), ctx);
		expect(notifications).toHaveLength(2);
	});

	it("includes the auto-install failure note when the envelope carries one", () => {
		const state = createSessionState();
		const { ctx, notifications } = uiContext();

		toolResultHandler(state)(
			envelopeEvent("lsp", envelope("gopls", { notes: ["Automatic install exited 1: npm ERR! 404"] })),
			ctx,
		);

		expect(notifications[0]?.message).toContain("Automatic install exited 1: npm ERR! 404");
	});

	it("stays silent without a UI, for other statuses, and for other tools", () => {
		const state = createSessionState();
		const handler = toolResultHandler(state);
		const { ctx, notifications } = uiContext();

		handler(envelopeEvent("lsp", envelope("pyright")), CTX);
		handler(envelopeEvent("lsp", { status: "success", ok: true, servers: ["pyright"] }), ctx);
		handler(envelopeEvent("bash", envelope("pyright")), ctx);
		handler(envelopeEvent("lsp", "not an envelope"), ctx);

		expect(notifications).toEqual([]);
	});
});
