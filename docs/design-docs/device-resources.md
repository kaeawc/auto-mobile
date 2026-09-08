# Device resources

`DeviceResource` describes observed resource state for one device. Its `resources`
property is a JSON object keyed by logical resource name. `AndroidDeviceResource`
and `AppleDeviceResource` add platform-specific keys and preserve AutoMobile's
`android` and `ios` platform identifiers.

This contract defines reporting semantics. It does not inspect devices, change
provisioning settings, suspend services, or expose a new tool. Future producers
must obtain evidence before reporting an observed state.

## Resource groups

| Key                  | Platform | Scope                                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `backgroundSync`     | Both     | OS-scheduled app background refresh/sync, excluding the platform-specific cloud/account service groups below. |
| `searchIndexing`     | Both     | OS-maintained search indexes; excludes app-owned indexes.                                                     |
| `animations`         | Both     | System UI transition animations; excludes app-rendered animation.                                             |
| `googlePlayServices` | Android  | Google Play services background infrastructure, including account sync and push; excludes the Play Store app. |
| `icloudSync`         | iOS      | OS-managed iCloud data synchronization, including photo sync; excludes app-owned networking.                  |
| `photoAnalysis`      | iOS      | On-device analysis of the system photo library; excludes photo synchronization.                               |

The groups describe separate functions even when they share infrastructure. For
example, photo sync belongs to `icloudSync`, while local photo analysis belongs to
`photoAnalysis`. Common background scheduling and platform-specific account
services may share dependencies; changing one does not establish the other's state.
Native service names and commands belong in future platform implementations.

## Observed state

Every key for the selected platform must be present, including on physical devices
or images without a particular service. Key presence does not promise support.

- `enabled`: verified active and available to run; need not be consuming CPU now.
- `disabled`: verified disabled to reduce resource use.
- `unsupported`: the device cannot provide or control the resource. Use `reason`
  to explain which limitation applies.
- `unknown`: not verified. Also use this for mixed or incomplete group evidence,
  with `reason` explaining the uncertainty.

A group is `enabled` or `disabled` only when evidence covers the whole defined
group. A single inactive process, absent observation, or requested setting is
insufficient. A future producer must define its evidence coverage for each OS and
device type; it must report `unknown` when that coverage is incomplete.

Desired provisioning configuration is separate from this snapshot. There is no
overall mode or profile identity, and callers must not infer that a requested
reduction succeeded.

## Automation capabilities

Resource state does not establish whether screenshots, interaction, notifications,
purchases, or other automation capabilities work. Continue to report capabilities
separately using AutoMobile's existing supported/partial/unavailable/unsupported
conventions. Only mark a capability unavailable because of a disabled resource
when its dependency is known for the device and app context.
