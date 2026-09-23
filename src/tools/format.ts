/**
 * Result shaping for the tool layer.
 *
 * Two outputs per call:
 *  - `content[0].text` — compact, model-facing prose the model actually reads.
 *  - `details` — an {@link LspEnvelope}, machine-stable for rendering, tests,
 *    and future transports.
 *
 * Model-facing text is always truncated with Pi's own helpers and always says
 * how to narrow the query. A tool that silently returns 40k of JSON teaches the
 * model nothing except to stop calling it.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { LspDiagnostic, LspEnvelope, LspLocation, LspStatus } from "../types.ts";

/** Limits applied to every model-facing result. */
export const RESULT_MAX_LINES = DEFAULT_MAX_LINES;
export const RESULT_MAX_BYTES = DEFAULT_MAX_BYTES;

export interface CapResult<T> {
	items: T[];
	/** True when items were dropped by `maxResults`. */
	truncated: boolean;
	/** Count before capping. */
	total: number;
}

/** Build an envelope with sensible defaults for the optional fields. */
export function createEnvelope(
	_operation: string,
	_status: LspStatus,
	_partial?: Partial<LspEnvelope>,
): LspEnvelope {
	throw new Error("Not implemented: createEnvelope");
}

/** Stable ordering so identical queries produce identical text. */
export function sortLocations(_locations: readonly LspLocation[]): LspLocation[] {
	throw new Error("Not implemented: sortLocations");
}

/** Cap a result list, reporting whether anything was dropped. */
export function capResults<T>(_items: readonly T[], _maxResults: number): CapResult<T> {
	throw new Error("Not implemented: capResults");
}

/** Render locations as `path:line:character` lines with optional previews. */
export function renderLocations(_locations: readonly LspLocation[], _cwd: string): string {
	throw new Error("Not implemented: renderLocations");
}

/** Render diagnostics grouped by file, errors first. */
export function renderDiagnostics(_diagnostics: readonly LspDiagnostic[], _cwd: string): string {
	throw new Error("Not implemented: renderDiagnostics");
}

/** Render the human-facing summary for an envelope, including notes and hints. */
export function renderEnvelope(_envelope: LspEnvelope, _cwd: string): string {
	throw new Error("Not implemented: renderEnvelope");
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
	/** Appended guidance naming the narrowing options, when truncation occurred. */
	hint?: string;
}

/**
 * Truncate model-facing text and append a narrowing hint.
 *
 * The hint is the important half: it tells the model to raise `maxResults`
 * is *not* the fix, and that narrowing by `path`/`symbol`/`query` is.
 */
export function truncateForModel(
	_text: string,
	_options?: { maxLines?: number; maxBytes?: number; hint?: string },
): TruncatedText {
	throw new Error("Not implemented: truncateForModel");
}

export { truncateHead, formatSize, type TruncationResult };
