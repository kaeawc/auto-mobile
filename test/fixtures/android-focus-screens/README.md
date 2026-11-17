# Android focus screen fixtures (#17209)

Each file is a `FocusScreen` (`{"focused": Element, "elements": Element[]}`), the read
`focusNavigate` itself takes, captured verbatim from the walk. They are not `observe` results,
which is why they live apart from `test/fixtures/android-focus/` (the observe payload contract
test globs that directory).

| Files                                                                             | Capture                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playground-slider-settling-before.json`, `playground-slider-settling-after.json` | API 36 `android-tv` `tv_1080p` emulator, captured 2026-11-16 on main `a427a230cd0` from the walk's own reads in the Playground Tap screen. The slider is read at 50% mid-settle (top 434) and, after one DPAD_DOWN, at 49% (top 433). |
