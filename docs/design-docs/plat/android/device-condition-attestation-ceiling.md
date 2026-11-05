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

## Emulator attestation fields

The captured chain from an Android 15 (API 35) `google_apis` arm64 userdebug
emulator has these leaf certificate fields:

| Field                                                  | Captured value                          |
| ------------------------------------------------------ | --------------------------------------- |
| `attestationSecurityLevel`                             | Software (0)                            |
| `keymasterSecurityLevel`                               | Software (0)                            |
| `deviceLocked`                                         | `false`                                 |
| `verifiedBootState`                                    | Unverified (2)                          |
| `attestationApplicationId.packageInfos[0].packageName` | `dev.jasonpearson.automobile.ctrlproxy` |

`attestationApplicationId` identifies the package that generated the key.
The tool therefore returns CtrlProxy's package, not the app under test.
The root is the last certificate in the chain.

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
It is not confirmed whether any test can force `MEETS_DEVICE_INTEGRITY` or
`MEETS_STRONG_INTEGRITY` onto an emulator, which verdicts are selectable, or
whether sideloaded builds receive forced verdicts.
