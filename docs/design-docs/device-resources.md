# Device resources

`DeviceResource` describes observed resource state for one device. Its `resources`
property is a JSON object keyed by logical resource name. `AndroidDeviceResource`
and `AppleDeviceResource` add platform-specific keys and preserve AutoMobile's
`android` and `ios` platform identifiers.

The generic base is a shared view and extension point; its default guarantees only
the common keys. Producers of complete platform reports use `AndroidDeviceResource`
or `AppleDeviceResource`. Consumers needing platform narrowing accept their union,
`AndroidDeviceResource | AppleDeviceResource`, rather than widening to the base.

Known map fields are declared explicitly so an unchecked `Record<string, ...>`
cannot stand in for a complete platform snapshot. Compile-only contract fixtures
run through the normal TypeScript gate. These types do not validate external JSON;
a future I/O boundary must validate incoming data before constructing a report.
The interfaces use structural typing: they require the known fields but do not
strip or reject additional properties on already-assembled objects.

This contract defines reporting semantics. `setDeviceResources` and the optional
`provisionDevice.resources` field accept a separate desired configuration and
return verification evidence. Requested configuration is never treated as
observed state.

## Resource groups

| Key                  | Platform | Scope                                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `backgroundSync`     | Both     | OS-scheduled app background refresh/sync, excluding the platform-specific cloud/account service groups below. |
| `searchIndexing`     | Both     | OS-maintained search indexes; excludes app-owned indexes.                                                     |
| `animations`         | Both     | System UI transition animations; excludes app-rendered animation.                                             |
| `wallpaperRendering` | Both     | System wallpaper rendering; excludes widgets and Live Activities.                                             |
| `widgets`            | Both     | App and system widget refresh; excludes wallpaper and Live Activities.                                        |
| `liveActivities`     | Both     | Live Activities and Dynamic Island updates; excludes wallpaper and widgets.                                   |
| `googlePlayServices` | Android  | Google Play services background infrastructure, including account sync and push; excludes the Play Store app. |
| `icloudSync`         | iOS      | OS-managed iCloud data synchronization, including photo sync; excludes app-owned networking.                  |
| `photoAnalysis`      | iOS      | On-device analysis of the system photo library; excludes photo synchronization.                               |

The groups describe separate functions even when they share infrastructure. For
example, photo sync belongs to `icloudSync`, while local photo analysis belongs to
`photoAnalysis`. Common background scheduling and platform-specific account
services may share dependencies; changing one does not establish the other's state.
Native service names and commands stay inside platform implementations.

## Observed state

Each concrete platform interface requires its core reporting keys, including on
physical devices or images without a particular service. Additional configurable
groups are optional in platform snapshots. Key presence does not promise support.

- `enabled`: verified active and available to run; need not be consuming CPU now.
- `disabled`: verified disabled to reduce resource use.
- `unsupported`: the device cannot provide or control the resource. The optional
  `reason` can explain which limitation applies.
- `unknown`: not verified. Also use this for mixed or incomplete group evidence,
  with an optional `reason` explaining the uncertainty.

A group is `enabled` or `disabled` only when evidence covers the whole defined
group. A single inactive process, absent observation, or requested setting is
insufficient. A future producer must define its evidence coverage for each OS and
device type; it must report `unknown` when that coverage is incomplete.

Desired provisioning configuration is separate from this snapshot. There is no
overall mode or profile identity, and callers must not infer that a requested
reduction succeeded.

## Configuring resources

`setDeviceResources` is disabled by default. Enable it for the MCP session with
`setToolEnabled` using `{"toolName":"setDeviceResources","enabled":true}`, or
start AutoMobile with `--enable-tool setDeviceResources`. Tool names are
case-sensitive. The optional `provisionDevice.resources` field does not require
enabling the standalone tool.

Both tools accept the same partial map of resource names to `enabled` or
`disabled`. Omitted entries remain untouched; an empty map, raw service names,
unknown keys, and profile names are rejected. Ordinary provisioning without
`resources` preserves existing behavior.

```json
{
  "resources": {
    "wallpaperRendering": "disabled",
    "widgets": "enabled",
    "liveActivities": "enabled",
    "healthServices": "disabled",
    "fitnessServices": "disabled"
  }
}
```

Pass this map to `setDeviceResources` with the usual session/device targeting,
or add it alongside `device` in `provisionDevice`. Provisioning requires
`boot: true` when resources are supplied and applies settings before automation
readiness. Resource settings participate in the provisioning operation ID's
fingerprint; retries re-read and reconcile resource state, including after a
completed operation.

`setDeviceResources.timeoutMs` defaults to 300,000 milliseconds for requests
that configure many services. Provisioning uses its existing shared deadline
for creation, boot, resource configuration, and automation readiness.
Within that deadline, resource configuration reserves time for readiness and
session binding. It cannot consume the whole remaining provisioning budget.

The iOS Simulator implementation controls narrow, disjoint service groups.
Wallpaper, widgets, and Live Activities are three independent controls: disabling
wallpaper never disables widget updates or Live Activities. No resource is disabled
by default. Settings can affect optional system features; they are choices for the
test workload, not a claim that every app remains fully functional with every
resource disabled.

| Controls                                                                   | Scope and tradeoff                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallpaperRendering`, `widgets`, `liveActivities`                          | Separate wallpaper rendering, widget refresh, and Live Activity updates. App widgets need `widgets` enabled.                                                                                                                     |
| `healthServices`, `homeServices`, `fitnessServices`                        | HealthKit/Health, HomeKit, and Fitness background services. Apps using those integrations need them enabled.                                                                                                                     |
| `familyServices`, `screenTime`                                             | Family approvals/parental controls and Screen Time/usage tracking. Keep enabled for restriction tests.                                                                                                                           |
| `newsServices`, `weatherServices`, `tipsServices`, `gameServices`          | Apple content apps and Game Center/save sync; controller input remains untouched.                                                                                                                                                |
| `mapsSync`                                                                 | Maps synchronization and suggested destinations; MapKit rendering and general location services remain untouched.                                                                                                                |
| `advertising`, `diagnosticReporting`                                       | Promoted Apple content and selected diagnostic reporting. Ad privacy, DeviceCheck, setup state, and feature configuration remain untouched. Disabling reporting reduces diagnostic evidence.                                     |
| `photoAnalysis`                                                            | Only background Photos analysis. Library access, cloud transfers, and shared media-analysis services remain untouched. Photo search and recognition can degrade.                                                                 |
| `assistantSuggestions`, `appleIntelligence`                                | Selected Siri suggestion and Apple Intelligence background services. Speech, system voices, shared language/model services, and runtime-gated intelligence workflows remain untouched. System intelligence features may degrade. |
| `searchIndexing`                                                           | System search and app-provided Spotlight indexes; excludes an app's own search service. Settings/Spotlight search may fail.                                                                                                      |
| `appStoreServices`, `appleMediaSync`                                       | App Store installation/update services and Apple media-library/subscription services; push, generic audio/video transport, and StoreKit payment daemons remain untouched by these controls.                                      |
| `mailServices`, `calendarServices`, `reminderServices`, `personalDataSync` | Local Mail, Calendar, Reminders, and Exchange/CalDAV/CardDAV sync. Local Contacts access remains untouched. These are separate from apps' server-side calendars and reminders.                                                   |
| `safariSync`, `icloudSettingsSync`                                         | Safari history/bookmark sync and selected system-settings sync/storage recommendations. Associated domains, shared credentials, browsing protection, Apple accounts, CloudKit, Drive, and Photos transfers remain untouched.     |
| `messagingMaintenance`                                                     | Apple Messages history cleanup/attachment transfer and FaceTime message storage; database XPC helpers, identity, CallKit, and VoIP infrastructure remain untouched.                                                              |
| `watchConnectivity`, `carPlay`, `tvRemote`, `findMy`, `continuity`         | Separate companion/device services. Continuity affects cross-device workflows; system share sheets, keyboard stickers, and avatars remain untouched.                                                                             |
| `walletServices`, `businessServices`                                       | Wallet/payment/digital-identity services and Apple business messaging. Disabling Wallet can also prevent dependent StoreKit payment sheets; keep it enabled for payment tests.                                                   |

App-hosted XPC helpers and the runtime-gated intelligence workflow engine remain
under OS control; these are not standalone service definitions to force-load.

The shared schema is defined by `src/models/deviceResourceDescriptions.ts`; native
labels are scoped in `src/utils/iosDeviceResourceCatalog.ts`. Callers cannot supply
raw launchd labels, shell commands, or arbitrary service paths. Every group is
preflighted against the exact booted runtime before writing. Missing labels are
reported individually and excluded from that runtime's group; a group with no
installed services is unsupported. A mismatched, default-disabled, or conditional
definition makes the whole group unsupported without mutations. Native read
failures are unknown, not evidence that a service is absent.

For compatible definitions the controller changes the launchd override, unloads
or restores the exact job without rebooting, then verifies both the override and
job registration. Runtime discovery is shared within a request. Group membership
does not overlap, so enabling one resource cannot silently restore another.

Broad `backgroundSync`, `icloudSync`, `googlePlayServices`, and `animations`
controls remain unsupported. Physical iOS devices and all Android resource
mutations return `unsupported` with a reason. Android accepts the same configuration
contract; its service catalog and control implementation are deferred. A request
may apply supported entries and report unsupported entries in the same result.

Results contain `requested`, a `resources` map of observed states for requested
entries, `services` with per-daemon evidence, `changed` (resource groups with
acknowledged native writes), `verification: "current_boot"`,
and `success`. Only a full match of every requested entry is successful. Native
failures or incomplete evidence produce `unknown`, never a guessed enabled or
disabled state. Group success requires every installed compatible service to
match; runtime-absent services remain visible as unsupported in `services`.
Retrying reconciles partial changes. Overrides may survive a
reboot depending on the runtime, but these tools verify only the current boot.

For `setDeviceResources`, an incomplete result is an MCP tool error with the
evidence intact. Provisioning returns that same result under `resources` and
also marks the response as an error if configuration is incomplete; it retains
the provisioned device identity and session so the caller can inspect or retry.
Device boot/readiness and resource-configuration success are separate facts.
Booted provisioning responses expose the session as `sessionUuid` and retain
`sessionId` as an equal compatibility alias, including resource failures and
replayed operations. With `boot: false`, neither session field is present.

## Automation capabilities

Resource state does not establish whether screenshots, interaction, notifications,
purchases, or other automation capabilities work. Continue to report capabilities
separately using AutoMobile's existing supported/partial/unavailable/unsupported
conventions. Only mark a capability unavailable because of a disabled resource
when its dependency is known for the device and app context.
