import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PEAK_STATUS_KEY, barStatusText, composePlan } from "./labels.ts";
import { deepseekPeakPricing, peakStateAt } from "./peak.ts";
import { PROVIDER, fetchOpenCodeGoUsage, type ProviderUsage } from "./usage.ts";

/**
 * Registers OpenCode Go with Gentle Shell and keeps the DeepSeek peak schedule
 * in view.
 *
 * Two surfaces, two different contracts:
 *
 * - The usage source feeds the status bar's usage segment and the
 *   `/gentle:usage` panel. The panel prints `plan` between the provider name and
 *   its `updated …` note, so the subscription tier and the schedule ride there.
 * - The bar chip is a pi status key. Gentle Shell strips escapes from extension
 *   statuses and paints them with its own muted role, so the chip says which
 *   schedule is running in the bar's own colour instead of colouring itself.
 *
 * Nothing here polls: Gentle Shell owns the refresh schedule for the source, and
 * the only timer is one that re-arms itself at the next schedule boundary so the
 * chip and the countdown never read as stale.
 */

/** Guards against firing a hair before the boundary it was armed for. */
const TRANSITION_MARGIN_MS = 1_000;

/** The model object pi hands the handler; only the two fields read are declared. */
interface SessionModel {
	id?: string;
	provider?: string;
}

interface PeakContext {
	model?: SessionModel;
	ui?: { setStatus?(key: string, text: string | undefined): void };
}

const PENDING_NOTE = "opencode-go · press r to fetch";

function modelOf(ctx: PeakContext | undefined): SessionModel | undefined {
	const model = ctx?.model;
	return model && typeof model === "object" ? model : undefined;
}

function isPeakPricedSessionModel(model: SessionModel | undefined): boolean {
	return Boolean(model) && deepseekPeakPricing(model?.provider ?? "", model?.id);
}

export default function (pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastContext: PeakContext | undefined;

	/**
	 * The source's plan field: the tier when one is known, then the schedule. The
	 * instant the shell passes is the fetch's own, so a refresh from the panel and
	 * the chip cannot disagree about which window is running.
	 */
	const withPlan = (usage: ProviderUsage, now: number): ProviderUsage => ({
		...usage,
		plan: composePlan(usage.plan, peakStateAt(now), now),
	});

	const sourceFetch = async (
		apiKey: string | undefined,
		fetchFn: typeof fetch,
		now: number,
	): Promise<ProviderUsage | undefined> => {
		const usage = await fetchOpenCodeGoUsage(apiKey, fetchFn, now);
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

	const clearTimer = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	/**
	 * Writes the bar chip for the session's main model and re-arms the boundary
	 * timer. A model that is not one of the two peak-priced DeepSeek ids clears
	 * the key instead, so switching models never leaves a stale claim behind.
	 */
	const sync = (ctx: PeakContext | undefined, now = Date.now()): void => {
		lastContext = ctx ?? lastContext;
		const setStatus = ctx?.ui?.setStatus;
		clearTimer();
		if (!isPeakPricedSessionModel(modelOf(ctx))) {
			setStatus?.(PEAK_STATUS_KEY, undefined);
			return;
		}
		const state = peakStateAt(now);
		setStatus?.(PEAK_STATUS_KEY, barStatusText(state));
		// One timer to the exact boundary: the chip flips when the schedule does,
		// not on the next turn, and nothing here polls.
		const delay = Math.max(TRANSITION_MARGIN_MS, state.until - now + TRANSITION_MARGIN_MS);
		timer = setTimeout(() => sync(lastContext), delay);
		// Never hold the process open for a schedule that changes in hours.
		(timer as { unref?: () => void }).unref?.();
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
		(ctx as PeakContext | undefined)?.ui?.setStatus?.(PEAK_STATUS_KEY, undefined);
	});
}
