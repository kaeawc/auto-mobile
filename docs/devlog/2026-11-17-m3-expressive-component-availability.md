# Material 3 Expressive component availability at the pinned Compose BOM

- Kind: concept
- Date: 2026-11-17
- Source: #15258
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Question

The Compose renderer could add Material 3 Expressive button groups, a split button, a FAB menu, a
loading indicator and wavy progress. This entry checks which of them the pinned Compose BOM ships,
and which still need `@OptIn(ExperimentalMaterial3ExpressiveApi::class)`.

## Method

The BOM version is `androidx-compose-bom` in `android/gradle/libs.versions.toml`. The
`compose-material` library takes its `material3` version from the BOM. The check read the BOM's POM
and the class files of each `material3-android` AAR. A component counts as experimental when its
public composables carry the `ExperimentalMaterial3ExpressiveApi` annotation in `javap -v` output.

## Result

Compose BOM 2026.09.00 resolves `androidx.compose.material3:material3` to **1.4.0**. That release
has `ExperimentalMaterial3ExpressiveApi`, `MaterialExpressiveTheme`, the expressive motion scheme
and the token classes for button groups, split buttons and loading indicators. It has none of the
components:

| Component                                        | material3 1.4.0 (pinned) | material3 1.5.0-rc01                                                      |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Button group, connected (`ButtonGroup`)          | Absent                   | Present, no opt-in                                                        |
| Split button (`SplitButtonLayout`)               | Absent                   | Present, no opt-in                                                        |
| FAB menu (`FloatingActionButtonMenu`, `…Item`)   | Absent                   | Present, no opt-in                                                        |
| Loading indicator (`LoadingIndicator`)           | Absent                   | Present; every `LoadingIndicator` and `ContainedLoadingIndicator` opts in |
| Wavy progress (`Linear`/`CircularWavyProgress…`) | Absent                   | Present, no opt-in                                                        |

The newest `material3` published on Google Maven at the time of the check is 1.5.0-rc01. There is
no stable 1.5.0.

## Implications

- None of the components can render at the pinned BOM. They need either a BOM that maps to
  `material3` 1.5.0, or an explicit `material3` pin to a 1.5.0 pre-release.
- At 1.5.0-rc01, only the loading indicator would sit behind
  `prototype_m3_expressive_experimental_v1`. Opt-in status can change before 1.5.0 is stable, so the
  check is repeated against whichever version is pinned when the renderer work starts.
