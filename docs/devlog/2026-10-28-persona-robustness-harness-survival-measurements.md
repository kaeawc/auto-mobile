# Persona robustness harness: survival measurements

- Kind: concept
- Date: 2026-10-28
- Source: moved from `how-it-works/plat/android/persona-robustness-harness.md`; #14061, #14056, #15764, #17155, #17170
- Shaped: [Persona robustness harness](../how-it-works/plat/android/persona-robustness-harness.md)

## Pending matrix input

Alias packs join the perturbation matrix once #14056 has fixtures.

## Emulator read-backs behind the survival scores

Measured on an Android 15 (API 35) google_apis arm64 emulator (#17155, #17170):

- The standby bucket `restricted` reads back as bucket 45, and `SCHEDULE_EXACT_ALARM` deny reads
  back as `deny`. Profiles that depend on those steps reflect emulator behaviour, not confirmed OEM
  effects.
- `user-restricted`'s `workmanager-periodic` is `ran` on API 35 and `never` on Android 14 (API 34),
  so the score table does not establish OEM behaviour.
