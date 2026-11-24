# Tool requirements

Every tool definition carries `_meta["automobile/requires"]`: a list of what the
tool needs before it can run, empty when it needs nothing. The registry derives it
from its runtime gates in `src/server/toolRequirements.ts`, so the declaration and
the gate are the same fact.

| Entry                 | Derived from                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdkEmbed`            | `embeddedSdkOnly`: the registry's embedded-SDK availability gate (`--embedded-sdk`)                                                                                           |
| `debugBuild`          | `debugOnly`: the registry's `debug` availability gate                                                                                                                         |
| `featureFlag:<key>`   | the tool's `featureFlags` registration option, checked against its handler's refusal                                                                                          |
| `platform:<platform>` | device-aware tools only: the platforms `assertToolSupportsDevicePlatform` admits, narrowed to the tool's `platforms` restriction and the input schema's `platform` vocabulary |

The platform gate admits Android and iOS for every device-aware tool, and watchOS,
tvOS and visionOS for the tools listed in `APPLE_PLATFORM_SUPPORTED_TOOLS`. Plain
tools look up their own target or need no device, so they carry no platform entry.
A device-aware tool whose handler can only drive some platforms registers them as
`platforms` (for example `["android"]`). The registry refuses any other device with one
`ActionableError` before the handler runs, so handlers do not check the platform
themselves. A handler can still answer `unsupported` for one action on a platform the
gate admits (for example `killProfile` apply on iOS, whose `list` works anywhere). Those
checks are not a registry gate, and the list does not reflect them.

`test/lint/androidOnlyToolPlatforms.test.ts` checks `src/` refusals such as
`<tool> is Android-only` and descriptions starting `Android:`. It fails when one names a
device-aware tool that lacks the restriction and is not in its exemption list
([decision record](../../devlog/2026-11-19-typed-tool-platform-restriction.md)).

## Drift check

`bun scripts/generate-tool-definitions.ts --check` (the `tool-definitions` Fast
Validation check) fails when:

- the committed `schemas/tool-definitions.json` differs from the live derivation;
- a `featureFlagDisabledMessage(flag, tool)` call in `src/` names a tool that does
  not declare that flag, or a tool declares a flag with no such refusal. It also
  fails when a call's flag or tool is not a string literal (the registry's own
  `debug` gate excepted);
- `APPLE_PLATFORM_SUPPORTED_TOOLS` lists a tool that is not registered, or a
  device-aware tool whose input schema refuses a platform the gate admits;
- a tool row's Platforms or Needs cell on `docs/tools.md` or a tool page differs from the
  definition, or the emoji key table between the `requires-key` markers on
  `docs/tools.md` differs from the generated key.

Each tool table ends with two generated columns. Platforms renders every
`platform:*` entry as an emoji, inside `<span class="tool-platforms">`; Needs renders
every other gate, inside `<span class="tool-needs">`. Each emoji carries its name as
hover text, and an empty cell is `—`. The docs stylesheet and
`docs-assets/src/tool-table.ts` find the tool tables by the `tool-platforms` class:
the stylesheet keeps tool names on one line, and the script adds a description toggle
that starts hidden on narrow screens.

The pure checks live in `scripts/lib/toolRequirementsDrift.ts`.
`bash scripts/update-tool-definitions.sh` regenerates both files and formats them.
