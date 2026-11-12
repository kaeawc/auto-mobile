# Device-condition attestation ceiling

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

iOS uses the same pattern (#14073).

## Exported attestation chain

`attestationApplicationId` identifies the package that generated the key, so the exported chain
names CtrlProxy's package (`dev.jasonpearson.automobile.ctrlproxy`), not the app under test. The
root is the last certificate in the chain.

## Play Integrity tester responses

In Play Console, **Protected with Play** (older pages: **App integrity**) >
**Play Integrity API** > **Manage** > **Testing** lets you create a test for
specified tester emails. Testers need access to the release through the internal
or intended test track. Tests return the chosen verdicts or error code with
`testingDetails.isTestingResponse` set to `true` in the decrypted payload.
See [Play Console testing instructions](https://support.google.com/googleplay/android-developer/answer/11395166?hl=en)
and [Play Integrity testing tools](https://developer.android.com/google/play/integrity/additional-tools).

Emulators fail device integrity by default, as described in the
[verdicts reference](https://developer.android.com/google/play/integrity/verdicts).

## Background

- [Device-condition attestation ceiling](../../../devlog/2026-10-22-device-condition-attestation-ceiling.md)
