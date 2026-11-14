/**
 * The strings Gentle Shell paints for the OpenCode Go peak schedule.
 *
 * Two surfaces, two different freedoms:
 *
 * - The usage panel prints `ProviderUsage.plan` inside its own muted role and
 *   never sanitizes it, so the header is plain text: the schedule rides there
 *   unconditionally, and red stays reserved for near-limit quota inside the
 *   panel. The panel already prints ` · ` before that field, so the field itself
 *   carries no leading separator.
 * - The widget line is this extension's own row above the editor, so it paints
 *   itself: `peak` is amber while DeepSeek is peak-priced, and every escape is
 *   closed with `\x1b[0m` so nothing leaks into neighbouring rows. Off-peak has
 *   no widget line at all.
 *
 * The panel's window labels stay untouched: the rows read `go 5h`, `go week`,
 * `go month`, with the schedule only on the provider line.
 *
 * Nothing here reads a clock; every function takes the instant it must describe.
 */

import { formatBoundaryClock, formatPeakState, type PeakState } from "./peak.ts";

/** The key this extension owns in pi's widget map. */
export const PEAK_WIDGET_KEY = "opencode-go-peak-widget";

const AMBER = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * The schedule the panel prints on its provider line, between the provider name
 * and the `updated …` note: `off-peak 3hr 20m`.
 *
 * The panel inserts its own ` · ` before this field, so the field never starts
 * with one: a leading separator here would render as a doubled ` ·  · `.
 */
export function panelSchedule(state: PeakState, now: number): string {
	return formatPeakState(state, now);
}

/**
 * The single widget line, shown only while DeepSeek is peak-priced:
 * `peak · 2× deepseek · until 04:00`. There is no off-peak variant; the caller
 * clears the widget instead. The boundary is rendered in the machine's own
 * timezone: `timeZone` is not passed here, only by unit tests that call
 * `formatBoundaryClock` directly.
 */
export function peakWidgetLine(state: PeakState, now: number): string {
	const clock = formatBoundaryClock(state.until, now);
	return `${AMBER}peak${DIM} · 2× deepseek · until ${clock}${RESET}`;
}
