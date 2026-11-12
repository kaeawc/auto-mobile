# Device-condition attestation ceiling

- Kind: decision
- Date: 2026-10-22
- Source: moved from `how-it-works/plat/android/device-condition-attestation-ceiling.md`; #14047, #14074, #14073, #14957, #16888
- Shaped: [Device-condition attestation ceiling](../how-it-works/plat/android/device-condition-attestation-ceiling.md)

## Context

Part of the device-condition fixtures epic (#14047). An emulator cannot present passing hardware
attestation (`Verified`/GREEN boot, `MEETS_DEVICE_INTEGRITY`, `MEETS_STRONG_INTEGRITY`,
`ctsProfileMatch`), so `setDeviceState` needed a rule for requests that name those states.

## Options

- Hard refusal of the whole request.
- Best-effort application with a warning.

## Decision

Hard refusal (#14074): the request fails with an `attestation_ceiling:` error before any injector
runs. iOS uses the same pattern (#14073).

## Consequences

- No silent false passes: a fixture whose test result is meaningless is worse than a failed call.
- If a legitimate best-effort caller appears, add an explicit opt-in field rather than loosening the
  default.

### Captured emulator attestation fields

From #16888, the leaf certificate of the chain captured on an Android 15 (API 35) `google_apis`
arm64 userdebug emulator:

| Field                                                  | Captured value                          |
| ------------------------------------------------------ | --------------------------------------- |
| `attestationSecurityLevel`                             | Software (0)                            |
| `keymasterSecurityLevel`                               | Software (0)                            |
| `deviceLocked`                                         | `false`                                 |
| `verifiedBootState`                                    | Unverified (2)                          |
| `attestationApplicationId.packageInfos[0].packageName` | `dev.jasonpearson.automobile.ctrlproxy` |

### Open questions

It is not confirmed whether any Play Integrity test can force `MEETS_DEVICE_INTEGRITY` or
`MEETS_STRONG_INTEGRITY` onto an emulator, which verdicts are selectable, or whether sideloaded
builds receive forced verdicts.
