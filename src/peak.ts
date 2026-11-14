/**
 * OpenCode Go's DeepSeek pricing schedule.
 *
 * OpenCode Go publishes two peak windows for its two DeepSeek models, and bills
 * them at double the off-peak rate. The windows are stated in UTC and only on
 * weekdays; every other hour, and both weekend days in full, are off-peak.
 *
 * ```
 * Peak 1  01:00-04:00 UTC   Monday through Friday
 * Peak 2  06:00-10:00 UTC   Monday through Friday
 * ```
 *
 * Nothing here reads a clock: every function takes the instant it must reason
 * about, so the panel and the bar never disagree and the schedule is testable
 * without freezing time.
 */

export const PROVIDER = "opencode-go";

/** The two published peak windows, in UTC hours, half-open (`start <= t < end`). */
const PEAK_WINDOWS = [
	{ startHour: 1, endHour: 4 },
	{ startHour: 6, endHour: 10 },
] as const;

/**
 * How far ahead to look for the next transition. A Friday evening can put the
 * next window three days out; the extra margin keeps the search correct without
 * ever approximating the answer.
 */
const DAYS_AHEAD = 9;

const MS_PER_DAY = 86_400_000;
const MINUTE_MS = 60_000;

export type PeakKind = "peak" | "off-peak";

export interface PeakState {
	kind: PeakKind;
	/** The instant this state ends, in epoch milliseconds. */
	until: number;
}

/**
 * The peak-priced model ids, matched leniently on purpose: the published ids
 * drift in punctuation (`v4.1-flash`, `v4-flash`, a `-high` reasoning suffix),
 * but the pricing contract is the family, not the spelling.
 */
const DEEPSEEK_PEAK_PRICING = /^deepseek-v4(?:\.1)?[-._]?(?:flash|pro)/i;

/** True when this provider/model pair is billed at the peak-priced rate. */
export function deepseekPeakPricing(provider: string, modelId: string | undefined): boolean {
	if (provider !== PROVIDER || typeof modelId !== "string") return false;
	return DEEPSEEK_PEAK_PRICING.test(modelId);
}

function isUtcWeekday(ts: number): boolean {
	const day = new Date(ts).getUTCDay();
	return day !== 0 && day !== 6;
}

/** The schedule predicate itself, evaluated at one instant. */
function isPeakInstant(ts: number): boolean {
	if (!isUtcWeekday(ts)) return false;
	const date = new Date(ts);
	const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
	return PEAK_WINDOWS.some(({ startHour, endHour }) => minute >= startHour * 60 && minute < endHour * 60);
}

/**
 * Every instant that could be a transition, before filtering. Weekends produce
 * candidates too; they are dropped by the transition test in `nextTransition`,
 * which is what keeps a Saturday 01:00 from being reported as a change.
 */
function candidateInstants(now: number): number[] {
	const date = new Date(now);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	const instants: number[] = [];
	for (let offset = 0; offset <= DAYS_AHEAD; offset++) {
		for (const { startHour, endHour } of PEAK_WINDOWS) {
			instants.push(Date.UTC(year, month, day + offset, startHour));
			instants.push(Date.UTC(year, month, day + offset, endHour));
		}
	}
	return instants;
}

/**
 * The next instant at which the schedule actually flips. A candidate counts only
 * when the predicate disagrees across it by one millisecond, so the answer is the
 * end of the current state whether that state is a peak window or an off-peak gap
 * that spans a weekend.
 */
export function nextTransition(now: number): number {
	let next = now + DAYS_AHEAD * MS_PER_DAY;
	for (const instant of candidateInstants(now)) {
		if (instant <= now || instant >= next) continue;
		if (isPeakInstant(instant - 1) !== isPeakInstant(instant)) next = instant;
	}
	return next;
}

/** Whether `now` falls in a peak window, and when that answer changes. */
export function peakStateAt(now: number): PeakState {
	if (!Number.isFinite(now)) return { kind: "off-peak", until: 0 };
	return { kind: isPeakInstant(now) ? "peak" : "off-peak", until: nextTransition(now) };
}

/**
 * A compact remaining time, in the same shape the shell uses for quota resets.
 * Rounds up, so a live window never reads as already over.
 */
export function formatCountdown(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "now";
	const minutes = Math.ceil(milliseconds / MINUTE_MS);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** `peak · change in 20m` or `off-peak · change in 3h`, without any colour. */
export function formatPeakState(state: PeakState, now: number): string {
	return `${state.kind} · change in ${formatCountdown(state.until - now)}`;
}
