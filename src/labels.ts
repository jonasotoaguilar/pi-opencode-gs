/**
 * The strings Gentle Shell paints for the OpenCode Go peak schedule.
 *
 * Two different surfaces, two different freedoms:
 *
 * - The usage panel prints `ProviderUsage.plan` inside its own muted role and
 *   never sanitizes it, so a red peak label survives there and stays grey when
 *   the schedule is off-peak, which is exactly the asked-for pair.
 * - The status bar owns its palette: every extension status goes through
 *   `sanitizeStatus`, which strips ANSI, and is repainted with the muted role.
 *   A status can therefore say which schedule is running, never colour it.
 *
 * Nothing here reads a clock; every function takes the instant it must describe.
 */

import { formatPeakState, type PeakState } from "./peak.ts";

/** The key this extension owns in pi's status map. */
export const PEAK_STATUS_KEY = "opencode-go-peak";

/**
 * Standard SGR red forward/back pair. The bar's own near-full red is a theme
 * role no extension can reach, so the panel uses the terminal's red and restores
 * the foreground instead of resetting every attribute, which would drop the
 * muted role the shell wrapped around the label.
 */
const RED = "\x1b[31m";
const FOREGROUND_DEFAULT = "\x1b[39m";

/** The short chip the status bar shows: `peak` or `off-peak`. */
export function barStatusText(state: PeakState): string {
	return state.kind === "peak" ? "peak" : "off-peak";
}

/**
 * The panel label: the schedule plus the time left in it, red while peak.
 *
 * Off-peak is left uncoloured on purpose: the surrounding plan role already
 * paints it in the same generic grey the profile chip uses.
 */
export function panelPeakLabel(state: PeakState, now: number): string {
	const label = formatPeakState(state, now);
	return state.kind === "peak" ? `${RED}${label}${FOREGROUND_DEFAULT}` : label;
}

/**
 * Composes the panel's plan field: the subscription tier when one is known, then
 * the schedule, so the label lands between the provider name and the `updated …`
 * note. A provider with no known tier still gets the schedule.
 */
export function composePlan(plan: string | undefined, state: PeakState, now: number): string {
	const label = panelPeakLabel(state, now);
	return plan && plan.length > 0 ? `${plan} · ${label}` : label;
}
