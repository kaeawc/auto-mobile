# Split the audit tool into `accessibilityAudit` and `performanceAudit`

- Kind: decision
- Date: 2026-11-13
- Source: #17279, #17280, #17282
- Shaped: [Accessibility and performance audits](../using/audits.md)

## Context

Two tools audited accessibility, each on one platform. On Android, `audit` ran the host-side WCAG
checks with scope, baseline and `failOn`. On iOS, `accessibilityAudit` ran XCUITest
`performAccessibilityAudit`. The `audit` tool also carried the only pass/fail performance and memory
checks, which an agent looking for a performance check had no reason to find in a tool whose
default kind was accessibility.

## Options

Not recorded.

## Decision

`accessibilityAudit` gained `engine: "platform" | "wcag"` with a per-platform default and took over
scope, baseline and `failOn`. A new `performanceAudit` tool took the performance and memory kinds
with `failOn`. Both shipped in #17280, with `audit` kept as a deprecated alias; `audit` was then
removed.

## Consequences

MCP clients and saved test plans that call `audit` fail with an unknown tool. Plans move
`audit kinds: ["accessibility"]` to `accessibilityAudit` (engine `wcag`, whose result is flat rather
than nested under `accessibility`) and `kinds: ["performance", "memory"]` to `performanceAudit`,
whose result is unchanged.
