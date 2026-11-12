# Tool requirements

Every tool definition carries `_meta["automobile/requires"]`: a list of what the
tool needs before it can run, empty when it needs nothing. The registry derives it
from its runtime gates in `src/server/toolRequirements.ts`, so the declaration and
the gate are the same fact.

| Entry                 | Derived from                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sdkEmbed`            | `embeddedSdkOnly`: the registry's embedded-SDK availability gate (`--embedded-sdk`)                                                    |
| `debugBuild`          | `debugOnly`: the registry's `debug` availability gate                                                                                  |
| `featureFlag:<key>`   | the tool's `featureFlags` registration option, checked against its handler's refusal                                                   |
| `platform:<platform>` | device-aware tools only: the platforms `assertToolSupportsDevicePlatform` admits, narrowed to the input schema's `platform` vocabulary |

The platform gate admits Android and iOS for every device-aware tool, and watchOS,
tvOS and visionOS for the tools listed in `APPLE_PLATFORM_SUPPORTED_TOOLS`. Plain
tools look up their own target or need no device, so they carry no platform entry.
A handler can still answer `unsupported` for a platform the gate admits (for example
an Android-only action on an iOS device); those checks are not a registry gate and
are not reflected in the list.

## Drift check

`bun scripts/generate-tool-definitions.ts --check` (the `tool-definitions` Fast
Validation check) fails when:

- the committed `schemas/tool-definitions.json` differs from the live derivation;
- a `featureFlagDisabledMessage(flag, tool)` call in `src/` names a tool that does
  not declare that flag, a tool declares a flag with no such refusal, or a call's
  flag or tool is not a string literal (the registry's own `debug` gate excepted);
- `APPLE_PLATFORM_SUPPORTED_TOOLS` lists a tool that is not registered, or a
  device-aware tool whose input schema refuses a platform the gate admits;
- a `docs/tools.md` tool row's Requires cell differs from the definition.

The pure checks live in `scripts/lib/toolRequirementsDrift.ts`.
`bash scripts/update-tool-definitions.sh` regenerates both files and formats them.
