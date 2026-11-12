# Android TV Compose focused card (#18028)

Captured, not hand-written: `observe-focused-card.json` is the excerpt of the
`observe` structuredContent reported in #18028, copied value for value (only
whitespace changed). It holds the `focusedElement` of a focused Compose for TV
card, which has no `text` or `content-desc` of its own, and the `skeleton` row
at the same bounds, labelled from the card's child text.

- Device: `system-images;android-36;android-tv;arm64-v8a` AVD (`tv_1080p`, emulator-5558)
- Daemon build: main `a14b2e6ef40`, private daemon
- App: a Compose for TV home screen (`dev.dogfood.tv`), found while working #16739
- Moment: `focusNavigate {until: {label: "Trending card 2"}}`, then `observe`
