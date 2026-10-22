# Device-condition attestation ceiling

Part of the device-condition fixtures epic (#14047); decision recorded in #14074.

## The ceiling

An emulator has no TEE or StrongBox and an unverified boot. It can present
failure and basic-tier attestation signals. It can never present:

- `verifiedBootState=Verified` (GREEN). Only ORANGE, YELLOW and failure states.
- Play Integrity `MEETS_DEVICE_INTEGRITY` or `MEETS_STRONG_INTEGRITY`.
- SafetyNet `ctsProfileMatch`.

Tests for failing, rooted or tampered attestation are supported. Tests that
need a passing hardware attestation need a physical device.

## What an emulator fixture can present

| Signal                                             | Presentable | Notes                           |
| -------------------------------------------------- | ----------- | ------------------------------- |
| Unlocked bootloader / ORANGE                       | yes         | emulator default                |
| YELLOW boot state                                  | yes         | custom-key signal               |
| Failing integrity verdict                          | yes         | the default                     |
| `Verified` / GREEN                                 | no          | requires verified boot          |
| `MEETS_DEVICE_INTEGRITY`, `MEETS_STRONG_INTEGRITY` | no          | requires TEE-backed attestation |
| `ctsProfileMatch`                                  | no          | requires certified hardware     |

## Refusal contract

`setDeviceState` with `deviceCondition` refuses the whole request, before any
injector runs, when it names an unsatisfiable state:

- `success: false`, error text prefixed `attestation_ceiling:`.
- The text names the requested field, explains the ceiling, and says to use a
  physical device.
- Nothing is applied, so there is no half-applied state to restore.

The decision (hard refusal over best-effort with a warning) avoids silent false
passes: a fixture whose test result is meaningless is worse than a failed call.
If a legitimate best-effort caller appears, add an explicit opt-in field rather
than loosening the default. iOS uses the same pattern (#14073).
