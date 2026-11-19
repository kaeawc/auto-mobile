# Typed platform restriction for device-aware tools

- Kind: decision
- Date: 2026-11-19
- Source: #18721
- Shaped: [Tool requirements](../how-it-works/mcp/tool-requirements.md)

## Context

`deriveToolRequirements` listed `platform:android` and `platform:ios` for every device-aware tool,
because the registry's platform gate admits both. Tools such as `captureTrace`, `heapDump` and
`measureStartup` refused iOS in their handlers, so `schemas/tool-definitions.json` and
`docs/tools.md` advertised iOS support that did not exist.

## Options

- Keep the handler checks and add an Android-only list beside `APPLE_PLATFORM_SUPPORTED_TOOLS`.
- Add a `platforms` registration option, derive `requires` from it and enforce it at the device
  dispatch, then drop the handler checks.

## Decision

Device-aware tools take a typed `platforms` option. The device dispatch refuses a device outside it
with one `ActionableError` before the Apple platform gate and the handler, and
`deriveToolRequirements` narrows `platform:*` to it. Tools that serve some actions on iOS
(`killProfile`, `manufacturerProfile`, `portReverse`) stay unrestricted.

## Consequences

The restricted tools' handlers no longer check the platform, and two (`sendBroadcast`,
`backgroundWork`) now refuse iOS with an error instead of a typed `unsupported` result.
`test/lint/androidOnlyToolPlatforms.test.ts` fails when an Android-only refusal or description
names a tool without the restriction.
