# Keyguard Handling

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `inputText` recovers a secure keyguard on Android by
> delivering the credential as key events when the accessibility path fails.
> Lock state is surfaced on `observe` and annotated on interactions
> (issues [#4235](https://github.com/kaeawc/auto-mobile/issues/4235),
> [#4280](https://github.com/kaeawc/auto-mobile/issues/4280),
> [#4360](https://github.com/kaeawc/auto-mobile/issues/4360)).
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

## The binding constraint: `config_lockScreenDisplayTimeout`

**Any keyguard interaction must complete inside roughly 7 seconds.** This is the
single most important — and least obvious — fact about driving a locked Android
device, so it is recorded here rather than left to be re-derived from tool
timing.

A locked keyguard powers its display off far sooner than an unlocked device, and
the window is **not** governed by the settable `screen_off_timeout` /
`sleep_timeout` keys. It is `config_lockScreenDisplayTimeout`, a framework config
**resource baked into the build**. No amount of `settings put` widens it.

Measured on `am-api35-ga-arm64` (API 35) with `screen_off_timeout=1800000`
(30 min) and `sleep_timeout=-1`, both confirmed effective in `dumpsys power`
(`mScreenOffTimeoutSetting=1800000`, `mSleepTimeoutSetting=-1`, no device-admin
cap):

| Elapsed | Unlocked (launcher) | Locked (keyguard) |
|---|---|---|
| 6s  | `Awake` / `ON`  | `Awake` / `ON`   |
| 9s  | `Awake` / `ON`  | `Dozing` / `OFF` |
| 12s | `Awake` / `ON`  | `Asleep` / `OFF` |
| 30s | `Awake` / `ON`  | `Asleep` / `OFF` |

The practical consequence: **credential entry must be a single, fast, un-observed
key-event burst.** A per-digit `tapOn` (or any observe/settle loop between
digits) cannot fit the budget — a single `tapOn` against a keyguard key was
measured at ~13s wall-clock, by which point the screen had already switched off.

## `inputText` on a keyguard (#4360)

A secure PIN/pattern/password bouncer exposes **no editable accessibility node**,
so the default `a11y` mode of `inputText` (a single `ACTION_SET_TEXT`) can never
type into it — it fails with `No focused editable node found`. Reporting that
error as the call's outcome is a false negative: an agent that (correctly)
distrusts a bare success flag and reads the error concludes the unlock failed,
then aborts or retries an action that had not actually run.

`inputText` therefore falls back automatically. The fallback fires **only** when
the accessibility leg has already failed **and** a pre-check
(`AdbClient.getDeviceLock`) confirms the device is locked **and** every character
of the text maps to a key event. The sequence:

```bash
adb shell input keyevent KEYCODE_WAKEUP   # wake the display
adb shell input keyevent KEYCODE_MENU     # raise the secure PIN bouncer
adb shell input keyevent KEYCODE_<digit>  # ...one per credential character
adb shell input keyevent KEYCODE_ENTER    # submit
```

The outcome is **grounded in a re-read of the lock state**, never in the fact
that the key events were sent:

- **Unlocked afterward** → `success: true`, `method: "eventAll"`, and the
  accessibility error is demoted to a non-fatal `warnings` entry.
- **Still locked afterward** → `success: false` with the error attributed to the
  keyguard leg (wrong credential or entry failure), never to accessibility.
- **Not locked at the pre-check, or text not key-event-mappable** → the original
  accessibility failure is returned unchanged; behavior is identical to before.

Because the credential is submitted, a wrong value counts as a failed unlock
attempt against the device's retry throttle. This path is reached only when a
caller has explicitly asked to input text at a device already known to be locked.

## What does NOT work (do not retry these approaches)

Verified during the #4360 session on the same secure PIN keyguard:

- **`wm dismiss-keyguard`** — dismisses only a *swipe* lock; it does not get past
  a secure lock. This is the existing call at `AndroidEmulatorClient.ts`
  (`wakeAndUnlock`), and it is why a freshly booted emulator with a PIN is not
  automatically usable.
- **Power-cycling the screen** (`keyevent 26` twice) does **not** raise the
  bouncer.
- **Per-digit `tapOn`** on `com.android.systemui:id/key1`…`key9` — cannot fit the
  ~7s budget (a single tap measured ~13s); subsequent taps return
  `0 view hierarchy changes` because the screen switched off mid-settle, which
  misleadingly reads as a missed target.

## What works to raise the bouncer

Any of these raise the secure PIN bouncer (confirmed via `uiautomator`:
`pinEntry` and `key1`–`key9` become present, and AutoMobile's own `observe` sees
them immediately afterward):

- `keyevent 82` (MENU) — used by the `inputText` fallback.
- `keyevent 8` (a digit) or `keyevent 66` (ENTER).
- `swipeOn --direction up --autoTarget false --speed slow`.

## Related

- Lock-state detection and the `deviceLock` observe field:
  `AdbClient.getDeviceLock` (issue
  [#4235](https://github.com/kaeawc/auto-mobile/issues/4235)).
- Interaction-level keyguard annotation / warning:
  `BaseVisualChange` (issue
  [#4280](https://github.com/kaeawc/auto-mobile/issues/4280)).
- A PIN-locked device also silently blocks `videoRecording`: `/sdcard` is
  credential-encrypted, so `screenrecord` cannot create its output file until the
  device is unlocked.
