# Android form factors: TV behaviour and fixture apps

Part of [Android form factors](form-factors.md).

## Android TV: behaviour and limits

The TV image is `system-images;android-36;android-tv;arm64-v8a` with profile `tv_1080p` (1920×1080 at 320 dpi), a user build that refuses `adb root`. The SDK tags `android-tv`, `google-tv`, `google-tv-ps16k` and the profiles `tv_1080p`, `tv_4k`, `tv_720p` match `src/models/formFactor.ts`. CtrlProxy installs and its accessibility service enables from the host with no TV-specific setup, and `observe` returns the hierarchy for the launcher and Settings.

The `google-tv` arm64-v8a image (`tv_1080p`) behaves the same: both images report touchscreen and leanback features, emulator characteristics, and no touch input device, and `observe`, `pressButton`, `sendKeys`, `focusNavigate`, the D-pad `tapOn` path, `launchApp`, `listApps` and CtrlProxy setup work on both. `swipeOn` has only been exercised on `android-tv`.

`focusedElement` follows the Leanback focus ring. `sendKeys` arrows move focus and `enter` activates. `focusNavigate` matches the target's own `contentDesc` or `resourceId`, and a static child label counts when it belongs to the focused control. Scrollable containers and ancestors of separately actionable controls cannot borrow those controls' labels. `pressButton` back and home, screenshots and video recording work. `launchApp` and `terminateApp` work for apps that only have a `LEANBACK_LAUNCHER` entry, and `listApps` includes them. The prototype overlay renders and dismisses, but its button is not reachable with D-pad focus. `observe.accessibilityState` reports the service as disabled and unknown while it is bound, which is an unexplained oddity.

**Signals and classification.** `ro.build.characteristics` is `emulator`, with no `tv`. Booted-device traits (`src/utils/android-cmdline-tools/deviceTraits.ts`) derive `formFactor` from this property, and on an emulator with no form factor there they fall back to `pm has-feature android.software.leanback`. AVD classification comes from the config's system-image tag or `tv_*` profile. The image reports `android.software.leanback`, `android.hardware.type.television`, `android.software.leanback_only` and `android.hardware.touchscreen` as present.

**Discovery.** Most tools are registered `defaultEnabled: false` so `tools/list` stays short on every device, and that policy is form-factor neutral: `executePlan`, `recordToolCalls`, `getLogs` and `provisionDevice` stay off on a TV too, reported in `gatedTools` and callable by name. `focusNavigate` is the exception (#18029): on a touchless TV it is the navigation primitive, so an acquisition whose result describes a TV (`formFactor: "tv"`, or platform `tvos`) enables every tool registered with the `defaultEnabledOnTv` trait (only `focusNavigate`) for the minted session (`src/features/toolSelection/formFactorDiscoveryTools.ts`, applied in `src/server/pipeline/ingress/acquisition.ts` with the caller's `enableTools`). It is written as an ordinary session override, so `setToolEnabled` can turn it off again, and it is skipped when a startup default or a session override already decides the tool, detected as the one case where `isEnabled` follows the declared default, so the narrow selection interface needs no new method. A connection-profile disable is not consulted; the session override unions with it as any `enableTools` would.

**Not covered:**

- Real no-touchscreen hardware behaviour.
- Touch-only `tapOn` options on touchless hardware; tracked by #17913.
- D-pad reach of prototype overlays (known gap).

## TV fixture apps

Two deterministic targets for TV checks and focus regression tests, with no network, no video decoding
and no Google account. Each has `LAUNCHER` and `LEANBACK_LAUNCHER` entries, a banner, and declares
touchscreen and leanback optional, so it installs on any TV or phone image at API 28 or later. Rows,
cards, search text and player tracks come from each module's catalog object; screen tags, button labels
and the player's state lines are the ones listed below. Changing either is a contract change.

Both embed the AutoMobile SDK and report each screen as an SDK navigation event, so `explore` records
them in the navigation graph and `navigateTo` can replay them. Screen names are part of the contract:
`BrowseDestination`, `SearchDestination`, `DetailDestination` (argument `cardId`) and
`PlayerDestination`; the Leanback fixture has only Browse and Detail. A screen is reported when it is
shown and again whenever the app resumes on it.

`android/tv-fixture` (`dev.jasonpearson.automobile.tvfixture`, launcher "AutoMobile TV Fixture") is
Compose for TV (`androidx.tv:tv-material`). Compose test tags are exposed as resource ids.

- Browse (`browse_rows`): the title, `Search` (`nav_search`) and `Player` (`nav_player`) buttons, the
  status line (`fixture_status`, starts `Ready`) and the focus line (`fixture_focus`, `Focused: none`
  until a card takes focus, then `Focused: Movies 03`). Below them the rows `row_featured`, `row_movies`
  and `row_shows`, each a `LazyRow` of 12 cards (`card_movies_01`..`card_movies_12`, titled
  `Movies 01`..`Movies 12`). About four and a half cards fit a 1080p row, so D-pad right past the last
  visible card scrolls the next one into view. Focus starts on `Featured 01`, also after back.
- Selecting a card opens its detail (`detail_title`, `detail_text` = `Detail for Movies 03`, focused
  `Play` = `detail_play`) and sets the status to `Selected Movies 03`. `Play` opens the player.
- Search (`search_field`, focused on entry): case-insensitive title match. `search_summary` reads
  `Type to search`, `No results`, `1 result` or `N results`; matches are cards in `search_results`.
- Player: `player_track` (`Track 1 of 3: Opening Titles`), `player_state` (`Paused`/`Playing`),
  `player_position` (`0:00 / 3:00`), `player_last_command` (`Last command: none`) and the buttons
  `player_previous`, `player_rewind`, `player_play_pause` (focused), `player_fast_forward`,
  `player_next`. Nothing plays and the position never ticks (the session publishes speed 0): fast-forward and rewind move 10 s, clamped
  to the track; next and previous change track, clamped to the 3-track playlist, and reset the position.
- Media keys: the activity owns a framework `MediaSession` (active for the activity's lifetime, state
  and metadata published on every change) and sets it as its window's media controller, so unhandled
  media keys reach it on every screen, as do transport controls from another controller. Play/pause
  (85, and headset hook 79), play (126), pause (127), stop (86), fast forward (90), rewind (89), next
  (87) and previous (88) run the same command as the on-screen buttons on the first down event of a
  press; `player_last_command` names it with `pressButton`'s button name (`playPause`, `fastForward`,
  `rewind`, `next`, `previous`). A recreated activity starts the player over.

`android/leanback-fixture` (`dev.jasonpearson.automobile.leanbackfixture`, launcher "AutoMobile
Leanback Fixture") is View-based Leanback: a `BrowseSupportFragment` titled `AutoMobile Leanback` with a
headers column (`Featured`, `Movies`, `Shows`) and one `ListRow` of 12 `ImageCardView` cards per header,
titled as in the Compose fixture with the card id as the content text. Selecting a card opens
`DetailActivity` (`detail_title`, `detail_text`). No search listener is set, so there is no search orb
and nothing asks for audio.
