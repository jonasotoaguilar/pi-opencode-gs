import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import extension from "../src/extension.ts";
import { PEAK_WIDGET_KEY } from "../src/labels.ts";
import { formatBoundaryClock, peakStateAt } from "../src/peak.ts";
import { USAGE_URL, type ProviderUsage } from "../src/usage.ts";

type Handler = (event: unknown, ctx: unknown) => void;

const PEAK_INSTANT = Date.parse("2026-09-23T03:40:00Z");
const OFF_PEAK_INSTANT = Date.parse("2026-09-23T04:30:00Z");

function usagePayload() {
	return {
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

interface WidgetCall {
	key: string;
	content: string[] | undefined;
	options: unknown[];
}

function harness(model: { id: string; provider: string } = { id: "deepseek-v4-flash", provider: "opencode-go" }) {
	const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
	const handlers = new Map<string, Handler[]>();
	const statuses = new Map<string, string | undefined>();
	const widgets: WidgetCall[] = [];
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
			setWidget: (key: string, content: string[] | undefined, ...options: unknown[]) => {
				widgets.push({ key, content, options });
			},
		},
	};
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return {
		pi,
		emitted,
		statuses,
		widgets,
		ctx,
		fire,
		setModel: (next: { id: string; provider: string }) => Object.assign(ctx, { model: next }),
	};
}

const sourceOf = (emitted: Array<{ payload: Record<string, unknown> }>) => emitted.at(-1)?.payload as {
	schema: string;
	provider: string;
	pendingNote?: string;
	fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<ProviderUsage | undefined>;
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

/**
 * The panel header the human asked for, as the source actually composes it, so the
 * session start has to run before the fetch.
 */
async function planFor(model: { id: string; provider: string }, now: number): Promise<string | undefined> {
	const { pi, emitted, fire } = harness(model);
	extension(pi as never);
	fire("session_start");
	const source = sourceOf(emitted);
	const usage = await source.fetch("secret", (async () => response(usagePayload())) as unknown as typeof fetch, now);
	return usage?.plan;
}

const GO_DEEPSEEK = { id: "deepseek-v4-flash", provider: "opencode-go" };

// The shell already prints ` · ` before the field, so the field itself never
// starts with a separator: a leading one would render as a doubled ` ·  · `.
const PLANS = {
	peak: "peak 20m",
	offPeak: "off-peak 1hr 30m",
};

test("the panel plan is the schedule, with no colour or leading separator of its own", async () => {
	assert.equal(await planFor(GO_DEEPSEEK, PEAK_INSTANT), PLANS.peak);
	assert.equal(await planFor(GO_DEEPSEEK, OFF_PEAK_INSTANT), PLANS.offPeak);

	// The panel paints `plan` in its own muted role, so the header is plain text.
	for (const plan of Object.values(PLANS)) {
		assert.equal(plan.includes("\x1b["), false, plan);
		assert.equal(plan.startsWith(" "), false, plan);
		assert.equal(plan.startsWith("·"), false, plan);
	}
});

test("the panel schedule is always present, whatever the session model or provider", async () => {
	// A model the schedule does not price still gets it: the panel is unconditional.
	assert.equal(await planFor({ id: "kimi-k2", provider: "opencode-go" }, PEAK_INSTANT), PLANS.peak);
	assert.equal(await planFor({ id: "kimi-k2", provider: "opencode-go" }, OFF_PEAK_INSTANT), PLANS.offPeak);
	// So does a session on another provider entirely.
	assert.equal(await planFor({ id: "kimi-k2", provider: "openrouter" }, OFF_PEAK_INSTANT), PLANS.offPeak);
	for (const provider of ["deepseek", "opencode-go", "openrouter"]) {
		assert.equal(await planFor({ id: "deepseek-v4-pro", provider }, PEAK_INSTANT), PLANS.peak, provider);
	}
});

test("the provider line always reads provider, schedule, then the update note", async () => {
	const line = async (model: { id: string; provider: string }, now: number): Promise<string> =>
		`opencode-go · ${await planFor(model, now)} · updated just now`;
	assert.equal(await line(GO_DEEPSEEK, PEAK_INSTANT), "opencode-go · peak 20m · updated just now");
	assert.equal(
		await line({ id: "kimi-k2", provider: "opencode-go" }, OFF_PEAK_INSTANT),
		"opencode-go · off-peak 1hr 30m · updated just now",
	);
	assert.equal(
		await line({ id: "kimi-k2", provider: "openrouter" }, OFF_PEAK_INSTANT),
		"opencode-go · off-peak 1hr 30m · updated just now",
	);
});

async function usageFor(model: { id: string; provider: string }, now: number): Promise<ProviderUsage | undefined> {
	const { pi, emitted, fire } = harness(model);
	extension(pi as never);
	fire("session_start");
	const source = sourceOf(emitted);
	return source.fetch("secret", (async () => response(usagePayload())) as unknown as typeof fetch, now);
}

const labelsOf = (usage: ProviderUsage | undefined): string[] | undefined =>
	usage?.limits[0].windows.map((window) => window.label);

// The panel draws `<limit name> <window label>` per row, so the schedule stays off
// these labels entirely: the rows read `go 5h`, `go week`, `go month` again.
test("the panel rows keep their plain labels whatever the schedule", async () => {
	assert.deepEqual(labelsOf(await usageFor(GO_DEEPSEEK, PEAK_INSTANT)), ["5h", "week", "month"]);
	assert.deepEqual(labelsOf(await usageFor(GO_DEEPSEEK, OFF_PEAK_INSTANT)), ["5h", "week", "month"]);
	assert.deepEqual(labelsOf(await usageFor({ id: "kimi-k2", provider: "opencode-go" }, PEAK_INSTANT)), [
		"5h",
		"week",
		"month",
	]);
});

test("a failed refresh yields no snapshot, so the shell keeps its last one", async () => {
	const { pi, emitted } = harness();
	extension(pi as never);
	const source = sourceOf(emitted);
	assert.equal(await source.fetch("secret", (async () => response(undefined, { ok: false, status: 401 })) as unknown as typeof fetch, PEAK_INSTANT), undefined);
	assert.equal(await source.fetch(undefined, (async () => response()) as unknown as typeof fetch, PEAK_INSTANT), undefined);
});

// The widget renders the boundary in the machine's own timezone, so the clock
// part is built with the same two-argument call the extension makes. The escapes
// and the shape around it are asserted literally. `formatBoundaryClock`'s own
// clock formatting is pinned to UTC in peak.test.ts.
const expectedPeakWidget = (now: number): string =>
	`\x1b[33mpeak\x1b[0m · 2× deepseek · until ${formatBoundaryClock(peakStateAt(now).until, now)}`;

const latestWidget = (widgets: WidgetCall[]): WidgetCall | undefined => widgets.at(-1);

const fetchOnce = (
	h: ReturnType<typeof harness>,
	now: number,
	fetchFn: typeof fetch = (async () => response()) as unknown as typeof fetch,
	apiKey: string | undefined = "secret",
): Promise<ProviderUsage | undefined> => sourceOf(h.emitted).fetch(apiKey, fetchFn, now);

/** A session whose provider has already answered one successful fetch. */
async function readySession(
	t: TestContext,
	now: number,
	model: { id: string; provider: string } = GO_DEEPSEEK,
	apis: Array<"Date" | "setTimeout"> = ["Date"],
) {
	t.mock.timers.enable({ apis, now });
	const h = harness(model);
	extension(h.pi as never);
	h.fire("session_start");
	await fetchOnce(h, now);
	h.fire("turn_end");
	return h;
}

test("a ready provider writes one peak widget line with the exact escapes", async (t) => {
	const h = await readySession(t, PEAK_INSTANT);
	const widget = latestWidget(h.widgets);
	assert.equal(widget?.key, PEAK_WIDGET_KEY);
	// The sync call writes exactly one line, and never an options argument.
	assert.deepEqual(widget?.content, [expectedPeakWidget(PEAK_INSTANT)]);
	assert.deepEqual(widget?.options, []);
	t.mock.timers.reset();
});

test("a ready provider outside a peak window clears the widget", async (t) => {
	const h = await readySession(t, OFF_PEAK_INSTANT);
	assert.equal(latestWidget(h.widgets)?.key, PEAK_WIDGET_KEY);
	assert.equal(latestWidget(h.widgets)?.content, undefined);
	t.mock.timers.reset();
});

test("the line follows provider readiness, never the session model", async (t) => {
	const h = await readySession(t, PEAK_INSTANT, { id: "kimi-k2", provider: "opencode-go" });
	assert.deepEqual(latestWidget(h.widgets)?.content, [expectedPeakWidget(PEAK_INSTANT)]);
	t.mock.timers.reset();
});

test("nothing is drawn until the first fetch proves the provider is logged in", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: PEAK_INSTANT });
	const h = harness();
	extension(h.pi as never);
	h.fire("session_start");
	h.fire("turn_end");
	assert.equal(latestWidget(h.widgets)?.key, PEAK_WIDGET_KEY);
	assert.equal(latestWidget(h.widgets)?.content, undefined);
	assert.equal(
		h.widgets.every((widget) => widget.content === undefined),
		true,
	);
	t.mock.timers.reset();
});

test("a missing key marks the provider unready and clears the widget", async (t) => {
	const h = await readySession(t, PEAK_INSTANT);
	assert.deepEqual(latestWidget(h.widgets)?.content, [expectedPeakWidget(PEAK_INSTANT)]);

	await sourceOf(h.emitted).fetch(undefined, (async () => response()) as unknown as typeof fetch, PEAK_INSTANT);

	assert.equal(latestWidget(h.widgets)?.key, PEAK_WIDGET_KEY);
	assert.equal(latestWidget(h.widgets)?.content, undefined);
	t.mock.timers.reset();
});

test("a network failure leaves readiness unchanged, so the line stays", async (t) => {
	const h = await readySession(t, PEAK_INSTANT);
	await fetchOnce(h, PEAK_INSTANT, (async () => {
		throw new Error("offline");
	}) as unknown as typeof fetch);
	h.fire("turn_end");
	assert.deepEqual(latestWidget(h.widgets)?.content, [expectedPeakWidget(PEAK_INSTANT)]);
	t.mock.timers.reset();
});

test("the boundary timer clears the widget when the peak window ends", async (t) => {
	const h = await readySession(t, PEAK_INSTANT, GO_DEEPSEEK, ["Date", "setTimeout"]);
	assert.deepEqual(latestWidget(h.widgets)?.content, [expectedPeakWidget(PEAK_INSTANT)]);

	// Still inside the same window: the line does not move on its own.
	t.mock.timers.tick(10 * 60_000);
	assert.deepEqual(latestWidget(h.widgets)?.content, [expectedPeakWidget(PEAK_INSTANT)]);

	// Past 04:00 UTC the armed timer fires and clears the widget rather than
	// swapping in another line.
	t.mock.timers.tick(11 * 60_000);
	assert.equal(latestWidget(h.widgets)?.key, PEAK_WIDGET_KEY);
	assert.equal(latestWidget(h.widgets)?.content, undefined);

	t.mock.timers.reset();
});

test("session shutdown clears the widget", async (t) => {
	const h = await readySession(t, PEAK_INSTANT);
	h.fire("session_shutdown");
	assert.equal(latestWidget(h.widgets)?.key, PEAK_WIDGET_KEY);
	assert.equal(latestWidget(h.widgets)?.content, undefined);
	t.mock.timers.reset();
});

test("the extension writes no status chip at all", async (t) => {
	const h = await readySession(t, PEAK_INSTANT);
	h.fire("session_shutdown");
	assert.equal(h.statuses.size, 0);
	assert.equal(
		h.widgets.every((widget) => widget.key === PEAK_WIDGET_KEY),
		true,
	);
	t.mock.timers.reset();
});
