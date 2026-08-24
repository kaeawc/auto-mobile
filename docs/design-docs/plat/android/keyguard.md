# Keyguard Handling & `wakeAndUnlock`

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** The `wakeAndUnlock` MCP tool wakes a device and gets past its
> keyguard cross-platform. Lock state is surfaced on `observe` and annotated on
> interactions (issues
> [#4235](https://github.com/kaeawc/auto-mobile/issues/4235),
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
(30 min) and `sleep_timeout=-1`, both confirmed effective in `dumpsys power`:

| Elapsed | Unlocked (launcher) | Locked (keyguard) |
| ------- | ------------------- | ----------------- |
| 6s      | `Awake` / `ON`      | `Awake` / `ON`    |
| 9s      | `Awake` / `ON`      | `Dozing` / `OFF`  |
| 12s     | `Awake` / `ON`      | `Asleep` / `OFF`  |

The practical consequence: **credential entry must be a single, fast, un-observed
key-event burst.** A per-digit `tapOn` (or any observe/settle loop between digits)
cannot fit the budget — a single `tapOn` against a keyguard key was measured at
~13s wall-clock, by which point the screen had already switched off (see
[#4366](https://github.com/kaeawc/auto-mobile/issues/4366)).

## The `wakeAndUnlock` tool

```
wakeAndUnlock({ pin?: string, platform? })
```

`pin` is optional in the schema but **logically required to unlock a secure
Android device** — if omitted there, a PIN remembered earlier this session is
used, otherwise the call returns an actionable error asking for one. It is
ignored on iOS.

### Android behavior

1. Read wakefulness (`dumpsys power`) and lock state (`dumpsys window policy`) —
   no `observe`, so it is fast and works on a screen that is about to power off.
2. If asleep, `KEYCODE_WAKEUP`.
3. **Not locked** → done (this is the "wake a sleeping device" case).
4. **Locked** → `wm dismiss-keyguard`, then branch on `secure`:
   - **Swipe lock** (`secure=false`) → `wm dismiss-keyguard` fully dismisses it.
   - **Secure lock** (`secure=true`) → the bouncer is now raised; type the PIN as
     key events and submit with `KEYCODE_ENTER`. The accessibility path cannot
     type into a secure bouncer (it exposes no editable a11y node — the original
     [#4360](https://github.com/kaeawc/auto-mobile/issues/4360) symptom), so key
     events are the only route.
5. Ground the outcome in a **bounded poll** of the lock state (≤~2.5s, every
   ~250ms) — never in the fact that keys were sent. There is a measured **~1.3s
   lag** between `KEYCODE_ENTER` and the keyguard clearing in
   `dumpsys window policy`; a single immediate re-read reports a false
   "still locked".

Recipe verified on API 35. Because a secure unlock **submits** the PIN, a wrong
value counts as a failed unlock attempt against the device's retry throttle.

### iOS behavior

iOS simulators **cannot set a device passcode** — there is no `simctl` lock/
passcode command and no "Face ID & Passcode" in Settings; pressing lock then
swiping up dismisses the lock screen with no credential prompt (verified on
iPhone 16 Pro, iOS 18.6). So on iOS the tool wakes the device and swipes the
non-secure lock screen away via the existing gesture primitives, and **ignores
any `pin`**. There is no iOS lock-state read equivalent to Android's dumpsys.

## Remembering how to unlock (`device_locks`)

To avoid re-entering a PIN every session, `wakeAndUnlock` records how to unlock a
device in a dedicated **`device_locks`** table keyed by `device_id`
(`device_id`, `lock_type`, `lock_credential`, added by the
`2026_07_24_000_device_locks` migration). It is deliberately **not** stored on
`device_sessions`: a session row only exists when device-pool autolock is
enabled, and never during boot, so session-scoped storage could not deliver
remember-then-reuse in the default config or at boot. A freshly-supplied PIN that
successfully unlocks a secure device is remembered; a recorded PIN is reused (and
not re-persisted); a PIN that failed to unlock is forgotten (so a changed PIN
does not get re-submitted into a lockout). The credential is stored plaintext in
the local, single-user `~/.auto-mobile` DB.

The **boot path** (`AndroidEmulatorClient.wakeAndUnlock`) delegates to the same
feature: a freshly-booted emulator with a swipe lock is dismissed automatically,
and a secure device is unlocked with the remembered PIN if one exists. A secure
device with no remembered PIN is left locked (non-fatal) — the device is still
ready, and the user unlocks it once with the tool to have it remembered.

## What does NOT work (do not retry these approaches)

Verified during the [#4360](https://github.com/kaeawc/auto-mobile/issues/4360)
sessions on a secure PIN keyguard:

- **`wm dismiss-keyguard` alone** — dismisses a _swipe_ lock, but on a _secure_
  lock it only **raises the bouncer**; it does not unlock. That is exactly why
  the tool follows it with PIN key events.
- **Accessibility `setText`** — the secure bouncer is not an editable a11y node,
  so `inputText` fails there with `No focused editable node found`. Unlocking is
  the job of `wakeAndUnlock`, not `inputText`.
- **Per-digit `tapOn`** on `com.android.systemui:id/key1`…`key9` — cannot fit the
  ~7s budget (a single tap measured ~13s); subsequent taps return
  `0 view hierarchy changes` because the screen switched off mid-settle, which
  misleadingly reads as a missed target.
- **Power-cycling the screen** (`keyevent 26` twice) does **not** raise the
  bouncer.

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
