# Changelog

## 0.1.0

- Register OpenCode Go as a Gentle Shell usage source, feeding the `alt+u` panel and the status bar's usage
  segment from the read-only `GET /zen/go/v1/usage` route.
- Read the three windows all or nothing, so a partial or malformed payload never under-reports a depleted
  subscription, and keep the bearer to the `Authorization` header with redirects refused.
- Report refresh failures by fixed code behind `PI_OPENCODE_GO_USAGE_DEBUG`, never the key or an error text.
- Print the subscription tier (`go`, `go plus`) after the provider name, read from the payload when it names one
  and otherwise from `PI_OPENCODE_GO_PLAN`; the rows become `go 5h`, `go week` and `go month`.
- Show the DeepSeek peak schedule it bills at double rate — 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday,
  everything else off-peak — with the time left in the current schedule, red while peak.
- Keep a `peak`/`off-peak` chip in the status bar for the two peak-priced DeepSeek ids, flipping at the boundary
  from a single armed timer rather than a poll.
