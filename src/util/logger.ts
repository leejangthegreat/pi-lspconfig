/**
 * stderr-only logging.
 *
 * pi-lspconfig must never write to stdout: in stdio-based modes stdout carries
 * the protocol stream. Every log line goes to stderr, and `console.log` is
 * never called from library code.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/** The `--lsp-log` flag value: `off` (default), a level name, or `verbose`. */
export type LogSetting = "off" | LogLevel | "verbose";

export interface CreateLoggerOptions {
	/** Minimum level to emit. `"off"` silences everything. */
	level?: LogSetting;
	/** Prefix for every line, e.g. `"[pi-lspconfig]"`. */
	prefix?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const NOOP = (): void => {};

function thresholdFor(level: LogSetting): number {
	if (level === "off") return Number.POSITIVE_INFINITY;
	if (level === "verbose") return LEVEL_ORDER.debug;
	return LEVEL_ORDER[level];
}

/** Create a logger that writes exclusively to stderr. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
	const prefix = options.prefix ?? "[pi-lspconfig]";
	const threshold = thresholdFor(options.level ?? "off");

	const emit =
		(level: LogLevel) =>
		(message: string, ...args: unknown[]): void => {
			if (LEVEL_ORDER[level] < threshold) return;
			const suffix = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
			process.stderr.write(`${prefix} ${level}: ${message}${suffix}\n`);
		};

	return {
		debug: threshold <= LEVEL_ORDER.debug ? emit("debug") : NOOP,
		info: threshold <= LEVEL_ORDER.info ? emit("info") : NOOP,
		warn: threshold <= LEVEL_ORDER.warn ? emit("warn") : NOOP,
		error: threshold <= LEVEL_ORDER.error ? emit("error") : NOOP,
	};
}

function formatArg(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Parse a `--lsp-log` flag value into a `LogSetting`, defaulting to `"off"`. */
export function parseLogSetting(value: boolean | string | undefined): LogSetting {
	if (value === undefined || value === false) return "off";
	if (value === true) return "verbose";
	switch (value) {
		case "off":
		case "debug":
		case "info":
		case "warn":
		case "error":
		case "verbose":
			return value;
		default:
			return "verbose";
	}
}
