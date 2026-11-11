# Android TV Compose home fixtures (#18027)

Captured, not hand-written: each value is a tool result copied from the
#16739 dogfood run as reported in #18027. Only whitespace was
changed; no field or value was edited.

- Device: `system-images;android-36;android-tv;arm64-v8a` AVD (`tv_1080p`, emulator-5558)
- Daemon build: main `a14b2e6ef40`, private daemon
- App: a Compose for TV home screen (`dev.dogfood.tv`): a Settings and a Search
  button above a `LazyColumn` of three `LazyRow`s of 8 `tv-material` Cards;
  only the first 5 cards of each row are composed on the 1920x1080 display.

| Key (`focus-navigate-offscreen-card.json`) | Capture                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `focusNavigateFromNoFocus`                 | `focusNavigate {until: {label: "Trending card 8"}}` after launch, nothing focused |
| `focusNavigateFromTrendingCard1`           | The same call with focus on Trending card 1                                       |
| `tapOnFromNoFocus`                         | `tapOn {selector: {text: "Trending card 8"}}` after the first call                |

The tests build their fake screens from these bounds and labels: rows at the
captured tops and width, the middle row's cards without a label as captured.
The card stride (424) is card 2's left edge, 488, from the #18028 `observe`
capture of the same app.
