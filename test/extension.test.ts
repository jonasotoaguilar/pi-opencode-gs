import assert from "node:assert/strict";
import test from "node:test";

import extension from "../src/extension.ts";
import { PEAK_STATUS_KEY } from "../src/labels.ts";
import { peakStateAt } from "../src/peak.ts";
import { USAGE_URL } from "../src/usage.ts";

type Handler = (event: unknown, ctx: unknown) => void;

const PEAK_INSTANT = Date.parse("2026-09-23T03:40:00Z");
const OFF_PEAK_INSTANT = Date.parse("2026-09-23T04:30:00Z");

function usagePayload(tier?: string) {
	return {
		...(tier ? { plan: tier } : {}),
		usage: {
			rolling: { status: "ok", percent: 12, resetsAt: "2026-09-23T17:00:00Z" },
			weekly: { status: "ok", percent: 37, resetsAt: "2026-09-30T12:00:00Z" },
			monthly: { status: "ok", percent: 96, resetsAt: "2026-10-23T12:00:00Z" },
		},
	};
}

function response(data: unknown = usagePayload(), options: Record<string, unknown> = {}) {
	return { ok: true, redirected: false, url: USAGE_URL, json: async () => data, ...options };
}

function harness(model: { id: string; provider: string } = { id: "deepseek-v4-flash", provider: "opencode-go" }) {
	const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
	const handlers = new Map<string, Handler[]>();
	const statuses = new Map<string, string | undefined>();
	const pi = {
		events: {
			emit: (name: string, payload: Record<string, unknown>) => {
				emitted.push({ name, payload });
			},
		},
		on: (name: string, handler: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	};
	const ctx = {
		model,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
		},
	};
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi, emitted, statuses, ctx, fire, setModel: (next: { id: string; provider: string }) => Object.assign(ctx, { model: next }) };
}

const sourceOf = (emitted: Array<{ payload: Record<string, unknown> }>) => emitted.at(-1)?.payload as {
	schema: string;
	provider: string;
	pendingNote?: string;
	fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<{ plan?: string } | undefined>;
};

test("registers the OpenCode Go usage source at load and again on every session start", () => {
	const { pi, emitted, fire } = harness();
	extension(pi as never);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].name, "gentle-pi:usage-source/v1");
	assert.equal(sourceOf(emitted).schema, "gentle-pi.usage-source/v1");
	assert.equal(sourceOf(emitted).provider, "opencode-go");
	assert.equal(typeof sourceOf(emitted).fetch, "function");
	assert.match(String(sourceOf(emitted).pendingNote), /opencode-go/);

	fire("session_start");
	assert.equal(emitted.length, 2);
	assert.equal(emitted[1].payload.provider, "opencode-go");
});

test("the panel plan carries the tier and the schedule, red only while peak", async () => {
	const { pi, emitted } = harness();
	extension(pi as never);
	const source = sourceOf(emitted);

	const duringPeak = await source.fetch("secret", (async () => response(usagePayload("go plus"))) as unknown as typeof fetch, PEAK_INSTANT);
	assert.equal(duringPeak?.plan, "go plus · \x1b[31mpeak · change in 20m\x1b[39m");

	const offPeak = await source.fetch("secret", (async () => response(usagePayload("go"))) as unknown as typeof fetch, OFF_PEAK_INSTANT);
	assert.equal(offPeak?.plan, "go · off-peak · change in 1h 30m");
	assert.equal(String(offPeak?.plan).includes("\x1b["), false, "off-peak inherits the panel's own grey");

	// No tier from the payload and none configured: the schedule still shows.
	const noTier = await source.fetch("secret", (async () => response()) as unknown as typeof fetch, OFF_PEAK_INSTANT);
	assert.equal(noTier?.plan, "off-peak · change in 1h 30m");
});

test("a failed refresh yields no snapshot, so the shell keeps its last one", async () => {
	const { pi, emitted } = harness();
	extension(pi as never);
	const source = sourceOf(emitted);
	assert.equal(await source.fetch("secret", (async () => response(undefined, { ok: false, status: 401 })) as unknown as typeof fetch, PEAK_INSTANT), undefined);
	assert.equal(await source.fetch(undefined, (async () => response()) as unknown as typeof fetch, PEAK_INSTANT), undefined);
});

test("the bar chip appears only for the peak-priced DeepSeek models on opencode-go", () => {
	const { pi, statuses, fire, setModel, ctx } = harness();
	extension(pi as never);
	const expected = peakStateAt(Date.now()).kind;

	fire("session_start");
	assert.equal(statuses.get(PEAK_STATUS_KEY), expected);

	fire("model_select");
	assert.equal(statuses.get(PEAK_STATUS_KEY), expected);

	for (const model of [
		{ id: "kimi-k2", provider: "opencode-go" },
		{ id: "deepseek-v4-pro", provider: "deepseek" },
	]) {
		setModel(model);
		fire("model_select");
		assert.equal(statuses.get(PEAK_STATUS_KEY), undefined, `${model.provider}/${model.id}`);
	}

	// Back to a peak-priced model: the chip returns.
	Object.assign(ctx, { model: { id: "deepseek-v4-pro", provider: "opencode-go" } });
	fire("model_select");
	assert.equal(statuses.get(PEAK_STATUS_KEY), expected);

	fire("session_shutdown");
	assert.equal(statuses.get(PEAK_STATUS_KEY), undefined);
});

test("the chip flips exactly when the schedule does, without polling", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: PEAK_INSTANT });
	const { pi, statuses, fire } = harness();
	extension(pi as never);
	fire("session_start");
	assert.equal(statuses.get(PEAK_STATUS_KEY), "peak");

	// Still inside the same window: the chip does not move on its own.
	t.mock.timers.tick(10 * 60_000);
	assert.equal(statuses.get(PEAK_STATUS_KEY), "peak");

	// Past the 04:00 UTC boundary the armed timer fires and the chip flips.
	t.mock.timers.tick(11 * 60_000);
	assert.equal(statuses.get(PEAK_STATUS_KEY), "off-peak");

	t.mock.timers.reset();
});
