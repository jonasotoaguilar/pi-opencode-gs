# pi-opencode-gs

OpenCode Go subscription usage in [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell): the
`/gentle:usage` panel behind `alt+u`, the usage segment in the status bar, and the DeepSeek peak/off-peak
pricing window OpenCode Go bills at double rate.

Gentle Shell ships built-in usage readers for Codex, Claude and NaN Cloud. This package registers OpenCode Go
through the `gentle-pi:usage-source/v1` event, so the shell treats it exactly like a built-in provider and owns
the refresh schedule.

## Requirements

- Gentle Shell with a `usage-source` capable version
- Pi `>= 0.85`, Node `>= 22.19`
- An `opencode-go` provider configured in Pi, with its API key stored as usual (`auth.json` or `OPENCODE_API_KEY`)

## Install

```sh
# Standalone Gentle Shell (the usual case)
gentle-shell install npm:pi-opencode-gs

# Gentle Shell linked to an existing pi home
gentle-shell --link install npm:pi-opencode-gs

# Plain Pi
pi install npm:pi-opencode-gs

# From a checkout
gentle-shell install ./pi-opencode-gs
```

Plain Pi has no listener for the event, so the extension is a no-op there. Reload (`/reload`) or restart, then
send one message with an `opencode-go/*` model and open `alt+u`.

## What you see

The panel, one row per window, with the tier and the schedule on the provider line:

```text
✿ Subscriptions
  opencode-go · go plus · peak · change in 20m · updated just now
    go 5h     ▰▱▱▱▱▱▱▱ 12% · resets in 1h 42m
    go week   ▰▰▰▱▱▱▱▱ 37% · resets in 1d 20h
    go month  ▰▰▰▰▰▰▰▰ 96% · resets in 4d 0h
```

Labels are lowercase, the way the panel writes everything else. `peak` is red and `off-peak` inherits the
panel's own grey; both carry the time left in that schedule. The percentages are what the endpoint answered at
the last refresh, never an average or an estimate, and `r` refreshes them.

In the status bar, the usage segment follows the active model as usual, and a schedule chip joins it while the
session's main model is one of the two peak-priced DeepSeek ids:

```text
deepseek-v4-flash · high │ ctx ▰▰▱▱▱▱▱▱ 24% │ $0.390 │ usage 5h ▰▱ 12% · week ▰▰▰ 37% · month ▰▰▰▰ 96% · peak · alt+u
```

The chip is `peak` or `off-peak`, lowercase, and it flips on its own at the boundary: the package arms one timer
to the exact transition and never polls.

## The peak schedule

OpenCode Go publishes two peak windows for DeepSeek V4.1 Flash and V4 Pro, billed at twice the off-peak rate on
input, output and cached reads:

| Window | UTC | Days |
| --- | --- | --- |
| Peak 1 | 01:00-04:00 | Monday through Friday |
| Peak 2 | 06:00-10:00 | Monday through Friday |

Everything else is off-peak, including both weekend days in full. The published contract names weekends only;
no holiday calendar is assumed, so a national holiday is billed as a normal weekday.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_OPENCODE_GO_PLAN` | The tier printed after the provider name (`go`, `go plus`, …) when the endpoint does not report one |
| `PI_OPENCODE_GO_USAGE_DEBUG` | Set to any value to log why a refresh produced no snapshot, by fixed code only |

The tier is read from the payload when it names one (`plan`, `planName`, `tier`, `subscriptionName`, or
`subscription.name`); the override stands in only when it does not. When neither says anything, no tier is
printed — a guessed plan is worse than none.

## How it works

One authenticated, read-only `GET` to a fixed route:

```
https://opencode.ai/zen/go/v1/usage
```

It answers with three windows, each a used percentage and a reset instant:

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-11-07T19:45:51.000Z" },
  "weekly":  { "status": "ok", "percent": 37, "resetsAt": "2026-11-09T00:00:00.000Z" },
  "monthly": { "status": "ok", "percent": 96, "resetsAt": "2026-11-24T21:47:15.000Z" }
} }
```

The read is all or nothing: a payload missing a window, or carrying a status other than `ok` or
`rate-limited`, yields no snapshot at all, so a depleted subscription never looks less used than it is. Gentle
Shell keeps the last valid snapshot through a failed refresh and shows its generic "fetch failed" note beside it.

The endpoint does not report how long its windows are, so `5h`, `week` and `month` are display durations (the
month is nominally 30 days). They only drive the label, the meter and the ordering; the percentage and the reset
time always come from the server.

## Security

This package handles a credential, so its behaviour is deliberately narrow:

- **One destination, hardcoded.** The only URL literal in the source is the usage route. No configuration,
  argument or environment variable can point the bearer anywhere else.
- **No redirects.** `redirect: "error"` plus a post-response check, so a `3xx` cannot replay the token.
- **Read-only.** Only `GET`. No disk writes, no settings or auth file changes, no shell, no `eval`.
- **The key never leaves the header.** It is not part of the returned snapshot, so it cannot reach the panel,
  the sidebar, a log or a session file. Diagnostics report fixed codes only.
- **No runtime dependencies, no install scripts.** Installing the package executes nothing.
- **Defensive parsing.** The payload is foreign JSON: every field is checked, validated and rebuilt, never
  merged into an existing object. Tiers and labels are rejected if they carry control characters.

## Known limits

- **The bar chip cannot be coloured or moved.** Gentle Shell owns the bar palette: every extension status runs
  through `sanitizeStatus` (ANSI stripped) and is painted with the muted role, after the cost and usage
  segments. The chip therefore reads `peak`/`off-peak` at the end of the line instead of sitting between the
  effort and profile chips. Both are extension-facing hooks the shell does not expose yet.
- **The schedule rides the provider line, not a note under the rows.** The panel's per-provider note slot is
  reserved for NaN's quota disclaimer, so the peak label goes into `plan`, between the tier and `updated …`.
- **The panel countdown is as fresh as the last refresh**, exactly like the quota percentages. The bar chip is
  not: it flips at the boundary from its own timer.
- **The endpoint is outside OpenCode's published OpenAPI**, so its shape may change; an unknown shape is
  rejected rather than displayed.
- **It reflects the subscription, not this session.** Usage you spend in the OpenCode CLI counts too.

## Development

```sh
npm run verify   # tsc --noEmit, then node --test
```

## License

MIT — see [LICENSE](LICENSE).

This is a community package: it is not an official Gentle Shell or OpenCode release.
