import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PEAK_WIDGET_KEY, panelSchedule, peakWidgetLine } from "./labels.ts";
import { peakStateAt } from "./peak.ts";
import { PROVIDER, fetchOpenCodeGoUsage, type FailureReason, type ProviderUsage } from "./usage.ts";

/**
 * Registers OpenCode Go with Gentle Shell and keeps the DeepSeek peak schedule
 * in view.
 *
 * Two surfaces, two different contracts:
 *
 * - The usage source feeds the status bar's usage segment and the
 *   `/gentle:usage` panel. The panel prints `plan` between the provider name and
 *   its `updated …` note, so the peak schedule always rides there, peak or not.
 * - The widget line above the editor is this extension's own row. It appears only
 *   while the opencode-go provider is usable AND the schedule is peak, whatever
 *   the session model is; every other combination clears it.
 *
 * Nothing here polls: Gentle Shell owns the refresh schedule for the source, and
 * the only timer is one that re-arms itself at the next schedule boundary so the
 * widget appears and disappears with the window.
 */

const TRANSITION_MARGIN_MS = 1_000;
const PENDING_NOTE = "opencode-go · press r to fetch";

interface PeakContext {
	ui?: { setWidget?(key: string, content: string[] | undefined): void };
}

export default function (pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastContext: PeakContext | undefined;
	// Unknown until a fetch proves the provider is logged in, so nothing is drawn
	// on a session whose key is missing.
	let providerReady = false;

	/**
	 * The source's plan field: the schedule, always, whatever the session model is
	 * and whether the window is peak or off-peak. The window labels are left exactly
	 * as read, so the panel's rows keep their plain `go 5h`, `go week`, `go month`
	 * names. The instant the shell passes is the fetch's own, so a refresh from the
	 * panel and the widget cannot disagree about which window is running.
	 */
	const withPlan = (usage: ProviderUsage, now: number): ProviderUsage => ({
		...usage,
		plan: panelSchedule(peakStateAt(now), now),
	});

	const clearTimer = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	/**
	 * Writes the single peak widget line and clears it for every other combination,
	 * then re-arms the boundary timer. The session model is irrelevant: provider
	 * readiness and the peak window are the only gates.
	 */
	const sync = (ctx: PeakContext | undefined, now = Date.now()): void => {
		lastContext = ctx ?? lastContext;
		const setWidget = ctx?.ui?.setWidget;
		clearTimer();
		if (!providerReady) {
			setWidget?.(PEAK_WIDGET_KEY, undefined);
			return;
		}
		const state = peakStateAt(now);
		if (state.kind === "peak") {
			setWidget?.(PEAK_WIDGET_KEY, [peakWidgetLine(state, now)]);
		} else {
			setWidget?.(PEAK_WIDGET_KEY, undefined);
		}
		// One timer to the exact boundary: the line appears and disappears when the
		// schedule does, not on the next turn, and nothing here polls.
		const delay = Math.max(TRANSITION_MARGIN_MS, state.until - now + TRANSITION_MARGIN_MS);
		timer = setTimeout(() => sync(lastContext), delay);
		// Never hold the process open for a schedule that changes in hours.
		(timer as { unref?: () => void }).unref?.();
	};

	/**
	 * The readiness gate: only `missing-key` proves the provider is unusable.
	 * Timeouts, network errors and malformed responses say nothing about whether
	 * the key is present, so they leave readiness exactly as it was.
	 */
	const markReady = (ready: boolean): void => {
		if (ready === providerReady) return;
		providerReady = ready;
		// A readiness change must appear without waiting for the next turn.
		sync(lastContext);
	};

	const sourceFetch = async (
		apiKey: string | undefined,
		fetchFn: typeof fetch,
		now: number,
	): Promise<ProviderUsage | undefined> => {
		const usage = await fetchOpenCodeGoUsage(apiKey, fetchFn, now, {
			report: (reason: FailureReason) => {
				if (reason === "missing-key") markReady(false);
			},
		});
		if (usage) markReady(true);
		return usage ? withPlan(usage, now) : undefined;
	};

	const register = (): void => {
		// Re-registering replaces the source, so this is safe on every session start
		// and keeps the extension's load order irrelevant.
		pi.events.emit("gentle-pi:usage-source/v1", {
			schema: "gentle-pi.usage-source/v1",
			provider: PROVIDER,
			pendingNote: PENDING_NOTE,
			fetch: sourceFetch,
		});
	};

	// Register at load and again on every session start: either load order works,
	// and a session switch re-targets the same provider.
	register();

	pi.on("session_start", (_event, ctx) => {
		register();
		sync(ctx as PeakContext | undefined);
	});

	pi.on("model_select", (_event, ctx) => sync(ctx as PeakContext | undefined));

	// A turn can cross a boundary; the next one re-reads the clock.
	pi.on("turn_end", (_event, ctx) => sync(ctx as PeakContext | undefined));

	pi.on("session_shutdown", (_event, ctx) => {
		clearTimer();
		(ctx as PeakContext | undefined)?.ui?.setWidget?.(PEAK_WIDGET_KEY, undefined);
	});
}
