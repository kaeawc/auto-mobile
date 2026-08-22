# Tool Capabilities & Registration Flags

<kbd>✅ Implemented</kbd>

> **Current state:** Session tool capabilities are enabled at runtime with the
> `setToolCapability` MCP tool and, at startup, via `AUTOMOBILE_TOOLSET_*`
> environment variables. The process-level `--debug` / `--embedded-sdk` gates are
> CLI args. See the [Status Glossary](../design-docs/status-glossary.md) for chip
> definitions.

AutoMobile deliberately exposes only a small **core** set of tools to a fresh MCP
session. Everything else is gated, so a client sees a lean, task-relevant tool
list instead of the full surface (dozens of tools) on first connect. This page
explains the gates, which tools each one controls, and how to turn them on.

## The core surface (always available)

These tools are never gated — they are present the moment you connect:

`observe`, `tapOn`, `tapAny`, `swipeOn`, `inputText`, `clearText`, `keyboard`,
`pressButton`, `homeScreen`, `recentApps`, `launchApp`, `terminateApp`,
`installApp`, `uninstallApp`, `listApps`, `listDevices`, `listDeviceImages`,
`getAndroid`, `getApple`, `killDevice`, `setActiveDevice`, `wakeAndUnlock`, and the
capability control tool `setToolCapability`.

Everything beyond this is reached through one of the three gates below.

## The three gates at a glance

| Gate | Granularity | Default | Turned on by | Hides from `tools/list`? |
|---|---|---|---|---|
| **Tool capabilities** | Group of tools, per MCP session | Off (empty) | `setToolCapability` tool, or `AUTOMOBILE_TOOLSET_*` at startup | Yes, until opted in |
| **`debugOnly`** | Per tool, process-wide | Off | `--debug` CLI arg, or `AUTOMOBILE_DEBUG=1` | Yes, unless debug is on |
| **`embeddedSdkOnly`** | Per tool, process-wide | Off | `--embedded-sdk` CLI arg | Yes, unless embedded-SDK is on |
| **`planOnly`** | Per tool | Always hidden | *(not user-toggleable)* | Yes, always (callable only inside plans) |

The gates are **independent and cumulative**. A tool tagged with more than one
gate stays hidden until *every* gate on it is satisfied — this is the single most
common source of "I enabled the capability but the tool still isn't there"
confusion. See [Why isn't my tool showing up?](#why-isnt-my-tool-showing-up)
below.

---

## Tool capabilities (the primary registration flags)

Advanced tools are grouped into **15 capabilities**. Each is **off by default**;
an agent opts into the ones it needs for the current session. Opting in is
cheap, reversible, and scoped to the session — it does not change what any other
connected client sees.

### The 15 capabilities

| Capability | Tools it exposes | Extra process gate on some tools |
|---|---|---|
| `clipboard` | `clipboard`, `selectAllText` | — |
| `advanced-interaction` | `openLink`, `imeAction`, `dragAndDrop`, `pinchOn`, `shake`, `rotate` | — |
| `app-permissions` | `getAppPermissions`, `setAppPermissions` | — |
| `device-settings` | `changeLocalization`, `getDeviceState`, `setDeviceState` | — |
| `device-control` | `provisionDevice` | — |
| `app-data-interop` | `putAppFile`, `getPreference`, `setPreference`, `sqlQuery`, `setKeyValue`, `removeKeyValue`, `clearKeyValueFile` | `sqlQuery`, `setKeyValue`, `removeKeyValue`, `clearKeyValueFile` also need **`--embedded-sdk`** |
| `notifications` | `systemTray`, `postNotification`, `getNotificationPolicy`, `setNotificationPolicy` | — |
| `telephony` | `phoneCall`, `sendSms` | — |
| `accessibility-tools` | `accessibility`, `accessibilityFocus` | `accessibilityFocus` also needs **`--debug`** |
| `screen-artifacts` | `videoRecording`, `deviceSnapshot`, `highlight` | — |
| `test-authoring` | `executePlan`, `startTestRecording`, `exportPlan`, `recordSteps`, `barrier`, `criticalSection` | `barrier` / `criticalSection` are **plan-only** and registered only in daemon mode (see below) |
| `network-inspection` | `network`, `mockNetwork`, `clearMockNetwork`, `getNetworkGraph` | all four also need **`--embedded-sdk`**; `mockNetwork` / `clearMockNetwork` additionally reject calls unless the daemon has **`--network-mockable`** (an action gate — see below) |
| `app-routing` | `getDeepLinks` | — |
| `navigation-modeling` | `navigateTo`, `getNavigationGraph`, `explore` | all three also need **`--debug`** *and* **`--embedded-sdk`** |
| `biometric-auth` | `biometricAuth` | — |

A tool that is not in any group is part of the core surface and is always
available (subject only to any process gate it carries).

### Enabling a capability at runtime

Call the always-available `setToolCapability` tool. It enables the capability for
the **current MCP session**, persists the choice, and emits
`notifications/tools/list_changed` so a directly connected client re-fetches its
tool list and sees the newly-exposed tools:

```jsonc
// Enable clipboard tools for this session
{ "name": "setToolCapability", "arguments": { "capability": "clipboard" } }
```

Parameters:

- **`capability`** *(required)* — one of the 14 names above.
- **`enabled`** *(optional, default `true`)* — set `false` to turn a capability
  back off.
- **`sessionUuid`** *(optional)* — the session profile to update. Omit it to
  update the profile for the connection making the call; that is the normal case.
  When provided it must identify the calling connection's own active capability
  or routing-session profile.

```jsonc
// Turn it back off
{ "name": "setToolCapability", "arguments": { "capability": "clipboard", "enabled": false } }
```

### Setting capability defaults at startup

To have a set of capabilities enabled the moment any session connects — useful
for a CI runner or an IDE integration with a known workflow — set environment
variables before the daemon starts. Two forms are read (both are consulted; their
effects union):

| Form | Example | Effect |
|---|---|---|
| `AUTOMOBILE_TOOLSET_DEFAULTS` | `AUTOMOBILE_TOOLSET_DEFAULTS=clipboard,telephony` | Comma-separated list of capability names. Unknown names are ignored. |
| `AUTOMOBILE_TOOLSET_<CAP>=1` | `AUTOMOBILE_TOOLSET_ADVANCED_INTERACTION=1` | Enable one capability. `<CAP>` is the capability name upper-cased with hyphens turned into underscores. Only the value `1` enables it. |

So `app-data-interop` becomes `AUTOMOBILE_TOOLSET_APP_DATA_INTEROP=1`, and
`network-inspection` becomes `AUTOMOBILE_TOOLSET_NETWORK_INSPECTION=1`.

```bash
# Start every session with clipboard + notifications enabled
export AUTOMOBILE_TOOLSET_DEFAULTS=clipboard,notifications
# Equivalent, one capability at a time
export AUTOMOBILE_TOOLSET_CLIPBOARD=1
export AUTOMOBILE_TOOLSET_NOTIFICATIONS=1
```

> Unlike most `AUTOMOBILE_*` variables, the `AUTOMOBILE_TOOLSET_*` names have **no**
> legacy `AUTO_MOBILE_*` alias — they are read under the `AUTOMOBILE_` spelling
> only.

### Persistence and precedence

- A per-session choice made with `setToolCapability` is **persisted** (in the
  SQLite store) and **survives daemon restarts**.
- The `AUTOMOBILE_TOOLSET_*` environment defaults are only a **fallback** for
  capabilities a session has not made an explicit choice about. An explicit
  `setToolCapability` call therefore always wins over the startup default — even
  after a restart — until it is explicitly changed again.
- Capabilities are scoped per session profile, so one client enabling a
  capability does not widen the surface another client sees.

---

## Process-level gates

These apply to every session in the MCP server (daemon) process. One is a
persistent, runtime-toggleable feature flag; the other is fixed for the life of
the process — the distinction matters, so they are called out below.

### `debugOnly` — the persistent `debug` flag (`--debug` / `AUTOMOBILE_DEBUG=1`)

Hides diagnostic and introspection tools unless debug mode is on. Tools behind
this gate include `debugSearch`, `bugReport`, `identifyInteractions`, `setUIState`,
`accessibilityFocus`, and the navigation tools (`navigateTo`, `getNavigationGraph`,
`explore`).

`debug` is a **persistent feature flag**, not a startup-only switch. `--debug` /
`AUTOMOBILE_DEBUG=1` set it at launch, but:

- The value is **persisted** and re-applied on the next daemon start, so debug
  tools can stay exposed after a restart *without* passing the flag again — and,
  conversely, stay hidden until the flag is explicitly turned back on.
- It can be toggled **while the daemon is running** (e.g. via the IDE
  `ide/setFeatureFlag` route), which changes tool availability live and emits
  `notifications/tools/list_changed`.

To turn it off, clear the `debug` feature flag; passing no CLI flag on the next
start is not sufficient if it was previously persisted on.

### `embeddedSdkOnly` — `--embedded-sdk` (startup-only)

Unlike `debug`, this gate is **fixed when the daemon starts** and is not a
persisted, runtime-toggleable feature flag. Tools behind it stay hidden until the
server is started with `--embedded-sdk`. They include `sqlQuery`, the key-value
storage tools (`setKeyValue`, `removeKeyValue`, `clearKeyValueFile`), the network
tools (`network`, `mockNetwork`, `clearMockNetwork`, `getNetworkGraph`), and the
navigation tools.

### `planOnly` — structural, not user-toggleable

`barrier` and `criticalSection` are always hidden from tool discovery: they are
callable only from **inside a plan**, never as a standalone `tools/call`. They are
also registered only when the server runs in **daemon mode**. There is no flag to
surface them in `tools/list` — this is by design.

> **Related runtime action gates:** a few tools are *visible* once their
> capability is enabled but still reject calls until a separate flag is on — the
> flag gates the *action*, not tool discovery:
>
> - `recordSteps` (`test-authoring`): its `begin`/`end` actions require the
>   `mcp-recording` feature flag (`--mcp-recording`); its `status` action always
>   works.
> - `mockNetwork` / `clearMockNetwork` (`network-inspection`): every call is
>   rejected with a disabled-feature error unless the daemon was started with
>   `--network-mockable`. So these two need the capability, `--embedded-sdk`
>   (to be discoverable), **and** `--network-mockable` (to actually run).

---

## Why isn't my tool showing up?

Because the gates are cumulative, work through them in order:

1. **Is it a capability tool?** Find the tool in the
   [15-capability table](#the-15-capabilities). If it's there, enable that
   capability — `setToolCapability` for this session, or `AUTOMOBILE_TOOLSET_*`
   at startup.
2. **Does it carry an extra process gate?** The right-hand column of that table
   flags the tools that *also* need `--debug` and/or `--embedded-sdk`. For example
   `navigateTo` needs the `navigation-modeling` capability **and** `--debug`
   **and** `--embedded-sdk` — enabling the capability alone is not enough.
3. **Is it `planOnly`?** `barrier` / `criticalSection` will never appear in
   `tools/list`; use them from within a plan.
4. **Did the client refresh its tool list?** `setToolCapability` emits
   `notifications/tools/list_changed`, and the default **proxy topology**
   forwards it: the daemon proxy invalidates its discovery cache and re-emits the
   notification to the connected client (issue #3223), so a client re-fetch of
   `tools/list` returns the updated surface without reconnecting. A client that
   caches its tool list and ignores the notification will still show a stale
   surface until it re-fetches.

---

## Related documentation

- **[Feature Flags](../design-docs/mcp/feature-flags.md)** — the CLI/env feature
  flags (`--debug`, `--embedded-sdk`, `--network-mockable`, output-size
  reduction, observe scope) and the `tools/list_changed` mechanics referenced
  above.
- **[Environment Variables](environment-variables.md)** — the full
  `AUTOMOBILE_*` environment surface, including the `AUTOMOBILE_TOOLSET_*`
  defaults described here.
- **[MCP Tools reference](../design-docs/mcp/tools.md)** — what each individual
  tool does.
