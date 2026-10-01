# iOS simulator lock-state fixtures (#8406, #5106)

Captured verbatim from a real simulator. Nothing here is hand-written.

- Date: 2026-09-30 (host clock; simulator clock 2026-10-01 UTC)
- Simulator: "MT iPhone 18 Pro iOS 27.0", UDID 1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E
- Runtime: iOS 27.0 (24A434); host macOS 26.6.2; runner built from commit
  26704d4bd with Xcode 26.6 (`xcodebuild build-for-testing`, scheme AutoMobileTest)
- Driver: private daemon from this checkout's `dist/` (private socket/pid/aux
  dirs, port range 19800-19850), one MCP stdio session.

## How the lock was produced

`pressButton {button: "power"}` (the IOHID power path from #8370). Before that the
simulator was freshly booted with `xcrun simctl boot` and was unlocked.

## Host-side signal (the reliable one)

```
xcrun simctl spawn <udid> notifyutil -g com.apple.springboard.lockstate
xcrun simctl spawn <udid> notifyutil -g com.apple.springboard.lockcomplete
xcrun simctl spawn <udid> notifyutil -g com.apple.springboard.hasBlankedScreen
```

| file                                          | state                    | lockstate | lockcomplete   | hasBlankedScreen |
| --------------------------------------------- | ------------------------ | --------- | -------------- | ---------------- |
| notifyutil-unlocked.txt                       | freshly booted, unlocked | 0         | (not captured) | (not captured)   |
| notifyutil-locked-immediately-after-power.txt | right after power press  | 1         | 1              | 0                |
| notifyutil-locked-t9s.txt                     | 9 s after power press    | 1         | (not captured) | (not captured)   |
| notifyutil-locked-screen-blanked.txt          | later, still locked      | 1         | 1              | 1                |

An unlocked simulator reports `lockstate 0`. A bare boot, before any lock,
also reported `lockstate 0`, `lockcomplete 0`, `hasBlankedScreen 0`.
Not captured: a clean return to `lockstate 0` after unlocking. The runner could
not restart on the blanked, locked simulator, so `wakeAndUnlock` could not run.

## Runner-side behaviour while locked (why the hierarchy is not usable)

- observe-unlocked.json: normal observe; there is no `deviceLock` field on iOS.
- observe-locked-immediately-after-power.json: `error: "Failed to retrieve
view hierarchy"`, cause `WebSocket connection closed`,
  `freshness.unavailableReason: "unknown"`, `screenSize` 0x0. No hierarchy.
- observe-locked-t9s.json: `unavailableReason: "auto_setup_failed"`, still no
  hierarchy. (This daemon predates PR 8437.)
- getApple-while-locked-error.txt and wakeAndUnlock-while-locked-error.txt:
  once the screen blanked, the CtrlProxy runner exited during startup, so the
  runner could not be restarted at all.
- pressButton-power-result.json: result of the power press itself.

Conclusion: the runner hierarchy is NOT a usable lock signal and the lock-screen
hierarchy was never returned. `notifyutil ... lockstate` was the only reliable
signal observed.
