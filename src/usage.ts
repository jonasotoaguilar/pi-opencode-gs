/**
 * OpenCode Go subscription usage, read from the read-only endpoint the OpenCode
 * console itself uses: `GET /zen/go/v1/usage`, authenticated with the same API
 * key Pi already holds for the `opencode-go` provider.
 *
 * The endpoint answers three windows and reports each as a used percentage plus
 * a reset instant. It does not publish how long a window is, so the spans below
 * are display durations: they drive the label, the meter width and the ordering
 * the shell draws, never the percentage or the reset time.
 */

export const PROVIDER = "opencode-go";

/** The only URL this package can reach. There is no configuration for it. */
export const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Matches Gentle Shell's own default provider window. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Opt-in diagnostics: fixed reason codes only, never a key or an error text. */
export const DEBUG_ENV = "PI_OPENCODE_GO_USAGE_DEBUG";

/** The row name: the panel prints `<limit name> <window label>` per line, lowercased
 * to match the panel's own lowercase voice. */
const LIMIT_NAME = "go";

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The endpoint's three windows. The month is approximated at 30 days because no
 * length is published for it; a calendar month is not always 30 days.
 */
const WINDOWS = [
	{ key: "rolling", label: "5h", seconds: 5 * HOUR },
	{ key: "weekly", label: "week", seconds: 7 * DAY },
	{ key: "monthly", label: "month", seconds: 30 * DAY },
] as const;

/**
 * The two statuses the endpoint is known to answer with. Anything else is
 * treated as a malformed payload rather than guessed at, because the shell
 * keeps its last good snapshot and a wrong number is worse than none.
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set(["ok", "rate-limited"]);

/** A full ISO 8601 instant, with an explicit offset or `Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Mirrors the `UsageWindow` Gentle Shell validates a registered source against.
 * Declared here because that type lives in a private module of gentle-pi, so a
 * contract drift shows up as the shell discarding this source rather than as a
 * failed import in this package.
 */
export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

/** Mirrors `UsageLimit`. */
export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
	scope?: "provider";
}

/**
 * Mirrors the `ProviderUsage` shape the same contract validates. The `plan` field
 * stays because the shell's contract has it; this source never fills it, since the
 * usage route publishes percentages only.
 */
export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

/** Why a refresh produced nothing. A fixed code, never a message. */
export type FailureReason =
	| "missing-key"
	| "timeout"
	| "network"
	| "redirect"
	| `http-${number}`
	| "invalid-json"
	| "unexpected-shape"
	| `unexpected-shape:${string}`;

export interface FetchOptions {
	timeoutMs?: number;
	/** Diagnostics sink; receives a fixed reason code only. */
	report?: (reason: FailureReason) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One window, or `undefined` when anything about it is untrustworthy. Fields are
 * read and rebuilt one by one, never merged, so a hostile payload cannot reach
 * this object.
 */
function parseWindow(value: unknown, label: string, windowSeconds: number): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.status !== "string" || !KNOWN_STATUSES.has(value.status)) return undefined;
	const percent = value.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
	if (typeof value.resetsAt !== "string" || !ISO_INSTANT.test(value.resetsAt)) return undefined;
	const resetAt = Date.parse(value.resetsAt);
	if (!Number.isFinite(resetAt)) return undefined;
	return { label, usedPercent: percent, windowSeconds, resetAt };
}

function readUsage(payload: unknown): Record<string, unknown> | undefined {
	if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
	return payload.usage;
}

/**
 * Converts one `/zen/go/v1/usage` payload into the windows Gentle Shell draws,
 * or `undefined` when the payload is not exactly the expected shape.
 *
 * All or nothing on purpose: a snapshot missing one window would make a depleted
 * subscription look less used than it is, and the shell already keeps the last
 * valid snapshot through a failed read.
 */
export function parseOpenCodeGoUsage(payload: unknown, now: number): ProviderUsage | undefined {
	if (!Number.isFinite(now)) return undefined;
	const usage = readUsage(payload);
	if (!usage) return undefined;
	const windows: UsageWindow[] = [];
	for (const { key, label, seconds } of WINDOWS) {
		const window = parseWindow(usage[key], label, seconds);
		if (!window) return undefined;
		windows.push(window);
	}
	const limitReached =
		windows.some((window) => window.usedPercent >= 100) ||
		WINDOWS.some(({ key }) => (usage[key] as { status?: unknown }).status === "rate-limited");
	return {
		provider: PROVIDER,
		plan: undefined,
		limits: [{ name: LIMIT_NAME, windows, limitReached, scope: "provider" }],
		fetchedAt: now,
	};
}

function defaultReport(reason: FailureReason): void {
	if (process.env[DEBUG_ENV]) console.error(`[pi-opencode-gs] ${reason}`);
}

interface RequestResult {
	usage?: ProviderUsage;
	reason?: FailureReason;
}

async function requestUsage(
	apiKey: string | undefined,
	fetchFn: typeof fetch,
	now: number,
	timeoutMs: number,
): Promise<RequestResult> {
	if (typeof apiKey !== "string" || apiKey.length === 0) return { reason: "missing-key" };
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	try {
		response = await fetchFn(USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			cache: "no-store",
			// A redirect could replay the bearer to another origin.
			redirect: "error",
			signal,
		});
	} catch {
		return { reason: signal.aborted ? "timeout" : "network" };
	}
	// Defense in depth: a fetch implementation that follows redirects anyway must
	// not deliver a body read from anywhere but this route.
	if (response.redirected || (response.url && response.url !== USAGE_URL)) return { reason: "redirect" };
	if (!response.ok) return { reason: `http-${response.status}` };
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { reason: signal.aborted ? "timeout" : "invalid-json" };
	}
	if (!isRecord(payload) || !isRecord(payload.usage)) return { reason: "unexpected-shape" };
	const usage = parseOpenCodeGoUsage(payload, now);
	if (!usage) {
		const missing = WINDOWS.find(({ key }) => !isRecord((payload.usage as Record<string, unknown>)[key]));
		return { reason: missing ? `unexpected-shape:${missing.key}` : "unexpected-shape" };
	}
	return { usage };
}

/**
 * Fetches one usage snapshot, or `undefined` when there is nothing trustworthy to
 * show. The key is used in the `Authorization` header and returned nowhere else;
 * failures resolve to `undefined` and report only a fixed reason code.
 */
export async function fetchOpenCodeGoUsage(
	apiKey: string | undefined,
	fetchFn: typeof fetch,
	now: number,
	options: FetchOptions = {},
): Promise<ProviderUsage | undefined> {
	const { timeoutMs = REQUEST_TIMEOUT_MS, report = defaultReport } = options;
	const { usage, reason } = await requestUsage(apiKey, fetchFn, now, timeoutMs);
	if (reason) {
		try {
			report(reason);
		} catch {
			// Diagnostics never break a refresh.
		}
	}
	return usage;
}
