import assert from "node:assert/strict";
import test from "node:test";

import { deepseekPeakPricing, formatCountdown, formatPeakState, peakStateAt } from "../src/peak.ts";

// Peak windows are published in UTC and only on weekdays:
// 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday. Everything else,
// including both weekend days, is off-peak.
const utc = (iso: string) => Date.parse(iso);

test("both published windows are peak on a weekday", () => {
	// 2026-09-23 is a Wednesday.
	for (const iso of ["2026-09-23T01:00:00Z", "2026-09-23T02:30:00Z", "2026-09-23T03:59:59Z"]) {
		assert.equal(peakStateAt(utc(iso)).kind, "peak", iso);
	}
	for (const iso of ["2026-09-23T06:00:00Z", "2026-09-23T08:15:00Z", "2026-09-23T09:59:59Z"]) {
		assert.equal(peakStateAt(utc(iso)).kind, "peak", iso);
	}
});

test("window bounds are half-open: a window starts on its first second and ends at its last", () => {
	assert.equal(peakStateAt(utc("2026-09-23T00:59:59Z")).kind, "off-peak");
	assert.equal(peakStateAt(utc("2026-09-23T04:00:00Z")).kind, "off-peak");
	assert.equal(peakStateAt(utc("2026-09-23T05:59:59Z")).kind, "off-peak");
	assert.equal(peakStateAt(utc("2026-09-23T10:00:00Z")).kind, "off-peak");
});

test("weekends are off-peak all day", () => {
	// 2026-09-26 is a Saturday, 2026-09-27 a Sunday.
	for (const iso of ["2026-09-26T02:00:00Z", "2026-09-26T08:00:00Z", "2026-09-27T02:00:00Z", "2026-09-27T08:00:00Z"]) {
		assert.equal(peakStateAt(utc(iso)).kind, "off-peak", iso);
	}
});

test("the boundary it reports is the end of the current state, in both directions", () => {
	const duringPeak = peakStateAt(utc("2026-09-23T03:40:00Z"));
	assert.deepEqual(duringPeak, { kind: "peak", until: utc("2026-09-23T04:00:00Z") }, "peak ends at its window close");

	const duringSecondPeak = peakStateAt(utc("2026-09-23T09:45:00Z"));
	assert.equal(duringSecondPeak.until, utc("2026-09-23T10:00:00Z"));

	const betweenWindows = peakStateAt(utc("2026-09-23T04:30:00Z"));
	assert.deepEqual(betweenWindows, { kind: "off-peak", until: utc("2026-09-23T06:00:00Z") }, "the next window is the boundary");

	const beforeAnyWindow = peakStateAt(utc("2026-09-23T00:30:00Z"));
	assert.equal(beforeAnyWindow.until, utc("2026-09-23T01:00:00Z"));
});

test("the boundary crosses into the next weekday, skipping the weekend", () => {
	// Friday 10:30 UTC is off-peak until Monday 01:00 UTC; nothing peaks over the weekend.
	assert.deepEqual(peakStateAt(utc("2026-09-25T10:30:00Z")), { kind: "off-peak", until: utc("2026-09-28T01:00:00Z") });
	// Sunday evening is off-peak until Monday 01:00 UTC.
	assert.deepEqual(peakStateAt(utc("2026-09-27T23:00:00Z")), { kind: "off-peak", until: utc("2026-09-28T01:00:00Z") });
	// Friday's second window ends at 10:00 and the next peak is Monday 01:00.
	assert.deepEqual(peakStateAt(utc("2026-09-25T09:00:00Z")), { kind: "peak", until: utc("2026-09-25T10:00:00Z") });
});

test("countdowns are compact and never round down to zero", () => {
	assert.equal(formatCountdown(0), "now");
	assert.equal(formatCountdown(-5_000), "now");
	assert.equal(formatCountdown(30_000), "1m");
	assert.equal(formatCountdown(20 * 60_000), "20m");
	assert.equal(formatCountdown(59 * 60_000 + 30_000), "1h");
	assert.equal(formatCountdown(80 * 60_000), "1h 20m");
	assert.equal(formatCountdown(22 * 3_600_000), "22h");
	assert.equal(formatCountdown(2 * 86_400_000 + 3 * 3_600_000), "2d 3h");
});

test("the state label names both schedules and their countdown", () => {
	const peak = peakStateAt(utc("2026-09-23T03:40:00Z"));
	assert.equal(formatPeakState(peak, utc("2026-09-23T03:40:00Z")), "peak · ends in 20m");
	const off = peakStateAt(utc("2026-09-23T04:30:00Z"));
	assert.equal(formatPeakState(off, utc("2026-09-23T04:30:00Z")), "off-peak · starts in 1h 30m");
});

test("only the two peak-priced DeepSeek models on opencode-go are peak-priced", () => {
	assert.equal(deepseekPeakPricing("opencode-go", "deepseek-v4.1-flash"), true);
	assert.equal(deepseekPeakPricing("opencode-go", "deepseek-v4-pro"), true);
	// Spelling drift in the ids is tolerated; the pricing, not the spelling, is the contract.
	assert.equal(deepseekPeakPricing("opencode-go", "deepseek-v4-flash"), true);
	assert.equal(deepseekPeakPricing("opencode-go", "deepseek-v4.1-flash-high"), true);
	// Another provider with the same model name does not inherit Go's schedule.
	assert.equal(deepseekPeakPricing("deepseek", "deepseek-v4.1-flash"), false);
	assert.equal(deepseekPeakPricing("opencode-go", "kimi-k2"), false);
	assert.equal(deepseekPeakPricing("opencode-go", undefined), false);
});
