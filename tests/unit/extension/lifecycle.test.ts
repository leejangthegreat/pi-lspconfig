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
