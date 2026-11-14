import assert from "node:assert/strict";
import test from "node:test";

import { fetchOpenCodeGoUsage, parseOpenCodeGoUsage, PROVIDER, REQUEST_TIMEOUT_MS, USAGE_URL } from "../src/usage.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function payload() {
	return {
		usage: {
			rolling: { status: "ok", percent: 20, resetsAt: "2026-09-23T17:00:00.000Z" },
			weekly: { status: "ok", percent: 42.5, resetsAt: "2026-09-30T12:00:00Z" },
			monthly: { status: "ok", percent: 55, resetsAt: "2026-10-23T12:00:00Z" },
		},
	};
}

function response(data: unknown = payload(), options: Record<string, unknown> = {}) {
	return { ok: true, redirected: false, url: USAGE_URL, json: async () => data, ...options };
}

test("maps the three Go windows into one provider-scoped snapshot", () => {
	assert.deepEqual(parseOpenCodeGoUsage(payload(), NOW), {
		provider: PROVIDER,
		plan: undefined,
		fetchedAt: NOW,
		limits: [
			{
				name: "go",
				scope: "provider",
				limitReached: false,
				windows: [
					{ label: "5h", usedPercent: 20, windowSeconds: 18_000, resetAt: Date.parse("2026-09-23T17:00:00.000Z") },
					{ label: "week", usedPercent: 42.5, windowSeconds: 604_800, resetAt: Date.parse("2026-09-30T12:00:00Z") },
					{ label: "month", usedPercent: 55, windowSeconds: 2_592_000, resetAt: Date.parse("2026-10-23T12:00:00Z") },
				],
			},
		],
	});
});

test("the subscription tier is read from the payload when it names one, never guessed", () => {
	for (const [field, value, expected] of [
		["plan", "Go Plus", "go plus"],
		["plan", "go_plus", "go plus"],
		["tier", "GO", "go"],
		["tier", "GoTeams", "goteams"],
		["subscription", { name: "Go Plus" }, "go plus"],
	] as const) {
		const data = { ...payload(), [field]: value } as unknown;
		assert.equal(parseOpenCodeGoUsage(data, NOW)?.plan, expected, `${field}: ${JSON.stringify(value)}`);
	}

	// Nothing usable in the payload, and nothing configured: no tier is claimed.
	assert.equal(parseOpenCodeGoUsage(payload(), NOW)?.plan, undefined);
	assert.equal(parseOpenCodeGoUsage({ ...payload(), plan: "   " }, NOW)?.plan, undefined);
	assert.equal(parseOpenCodeGoUsage({ ...payload(), plan: 42 }, NOW)?.plan, undefined);
	// A tier is printed on one terminal line, so only a short, plain label passes.
	assert.equal(parseOpenCodeGoUsage({ ...payload(), plan: "Go\nPlus" }, NOW)?.plan, undefined);
	assert.equal(parseOpenCodeGoUsage({ ...payload(), plan: "x".repeat(40) }, NOW)?.plan, undefined);
	// The configured override stands in only when the payload says nothing.
	assert.equal(parseOpenCodeGoUsage(payload(), NOW, "Go Plus")?.plan, "go plus");
	assert.equal(parseOpenCodeGoUsage({ ...payload(), plan: "Go" }, NOW, "Go Plus")?.plan, "go");
});

test("a full window or a rate-limited status marks the limit reached", () => {
	const full = payload();
	full.usage.weekly.percent = 100;
	assert.equal(parseOpenCodeGoUsage(full, NOW)?.limits[0].limitReached, true);

	const throttled = payload();
	throttled.usage.monthly.status = "rate-limited";
	assert.equal(parseOpenCodeGoUsage(throttled, NOW)?.limits[0].limitReached, true);

	const border = payload();
	border.usage.rolling.percent = 0;
	assert.equal(parseOpenCodeGoUsage(border, NOW)?.limits[0].limitReached, false);
});

test("any window that is missing or malformed rejects the whole snapshot", () => {
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const missing = payload() as { usage: Record<string, unknown> };
		delete missing.usage[key];
		assert.equal(parseOpenCodeGoUsage(missing, NOW), undefined, `missing ${key}`);

		for (const broken of [
			{ status: "ok", percent: "20", resetsAt: "2026-09-23T17:00:00Z" },
			{ status: "ok", percent: 20 },
			{ status: "ok", percent: 20, resetsAt: "yesterday" },
			{ status: "ok", percent: -1, resetsAt: "2026-09-23T17:00:00Z" },
			{ status: "ok", percent: 101, resetsAt: "2026-09-23T17:00:00Z" },
			{ status: "ok", percent: Number.NaN, resetsAt: "2026-09-23T17:00:00Z" },
			{ status: "active", percent: 20, resetsAt: "2026-09-23T17:00:00Z" },
			{ percent: 20, resetsAt: "2026-09-23T17:00:00Z" },
			null,
			[],
		]) {
			const data = payload() as { usage: Record<string, unknown> };
			data.usage[key] = broken;
			assert.equal(parseOpenCodeGoUsage(data, NOW), undefined, `broken ${key}: ${JSON.stringify(broken)}`);
		}
	}
	assert.equal(parseOpenCodeGoUsage({}, NOW), undefined);
	assert.equal(parseOpenCodeGoUsage({ usage: [] }, NOW), undefined);
	assert.equal(parseOpenCodeGoUsage({ usage: "nope" }, NOW), undefined);
	assert.equal(parseOpenCodeGoUsage(null, NOW), undefined);
	assert.equal(parseOpenCodeGoUsage(payload(), Number.NaN), undefined);
});

test("a missing key never sends a request", async () => {
	const fetchFn = () => {
		throw new Error("fetch must not run");
	};
	assert.equal(await fetchOpenCodeGoUsage(undefined, fetchFn as unknown as typeof fetch, NOW), undefined);
	assert.equal(await fetchOpenCodeGoUsage("", fetchFn as unknown as typeof fetch, NOW), undefined);
});

test("one GET to the fixed route, with the key only in the header, and no body leak", async () => {
	let calls = 0;
	const usage = await fetchOpenCodeGoUsage(
		"test-secret",
		(async (url: string, options: RequestInit) => {
			calls++;
			assert.equal(url, USAGE_URL);
			const { signal, ...rest } = options;
			assert.ok(signal instanceof AbortSignal);
			assert.deepEqual(rest, {
				method: "GET",
				headers: { Authorization: "Bearer test-secret", Accept: "application/json" },
				cache: "no-store",
				redirect: "error",
			});
			return response();
		}) as unknown as typeof fetch,
		NOW,
	);
	assert.equal(calls, 1);
	assert.equal(usage?.provider, PROVIDER);
	assert.equal(JSON.stringify(usage).includes("test-secret"), false);
});

test("failures resolve to no snapshot and report a fixed code, never the key", async () => {
	const reasons: string[] = [];
	const report = (reason: string) => reasons.push(reason);

	for (const [value, expected] of [
		[response(undefined, { ok: false, status: 401 }), "http-401"],
		[response(undefined, { ok: false, status: 500 }), "http-500"],
		[response(undefined, { redirected: true }), "redirect"],
		[response(undefined, { url: "https://other.example/usage" }), "redirect"],
		[response({ usage: {} }), "unexpected-shape:rolling"],
		[response({ usage: "nope" }), "unexpected-shape"],
	] as const) {
		const usage = await fetchOpenCodeGoUsage("secret", (async () => value) as unknown as typeof fetch, NOW, { report });
		assert.equal(usage, undefined, expected);
		assert.equal(reasons.at(-1), expected);
	}

	assert.equal(
		await fetchOpenCodeGoUsage("secret", (async () => {
			throw new Error("secret: network failure");
		}) as unknown as typeof fetch, NOW, { report }),
		undefined,
	);
	assert.equal(reasons.at(-1), "network");

	assert.equal(
		await fetchOpenCodeGoUsage("secret", (async () => response(undefined, {
			json: async () => {
				throw new Error("secret: invalid JSON");
			},
		})) as unknown as typeof fetch, NOW, { report }),
		undefined,
	);
	assert.equal(reasons.at(-1), "invalid-json");

	assert.equal(
		await fetchOpenCodeGoUsage(undefined, (async () => response()) as unknown as typeof fetch, NOW, { report }),
		undefined,
	);
	assert.equal(reasons.at(-1), "missing-key");
	assert.equal(reasons.join(" ").includes("secret"), false);
});

test("a throwing diagnostics sink cannot break a successful refresh", async () => {
	const usage = await fetchOpenCodeGoUsage("secret", (async () => response()) as unknown as typeof fetch, NOW, {
		report: () => {
			throw new Error("sink");
		},
	});
	assert.equal(usage?.provider, PROVIDER);
});

test("the request carries its own bounded window", async () => {
	let seen: AbortSignal | undefined;
	await fetchOpenCodeGoUsage("secret", (async (_url: string, options: RequestInit) => {
		seen = options.signal as AbortSignal;
		return response();
	}) as unknown as typeof fetch, NOW);
	assert.ok(seen instanceof AbortSignal);
	assert.equal(REQUEST_TIMEOUT_MS, 10_000);
});
