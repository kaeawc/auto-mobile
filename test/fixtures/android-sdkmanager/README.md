# android-sdkmanager fixtures

Captured output, not hand-written.

- `list-system-images-available.txt`: the `system-images/android-34/*` and
  `system-images/android-36/*` rows of the `Available packages:` section of
  verbatim `sdkmanager --list` stdout, captured 2026-10-22 on macOS from
  `~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager`. The rows span every tag the SDK
  repository ships (phone `google_apis*`/`default`, plus `android-wear*`, `android-tv`,
  `google-tv*`, `android-automotive*`, `android-desktop`, `ai-glasses`, ATD). Treated as "installed"
  by the provisioning tests to prove default selection never picks a non-handheld image (#14900).
