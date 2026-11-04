# androidx.car.app for Car App Library template snapshots

Status: accepted for #16751 (part of the Android Auto epic #16749).

Dependency: `androidx.car.app:app` (`compileOnly` in `auto-mobile-sdk`) and
`androidx.car.app:app-testing` (unit tests only)

## Decision

The SDK's opt-in template route reads Car App Library types (`Screen`, `ScreenManager`, `Template`
and the template models) to report an app's screen stacks. The library is declared `compileOnly`:
an app that uses the route already ships it, and an app that does not never loads a car class. The
debug provider reaches the recorder only through a car-free route object, so it answers
`enabled: false` in an app without the library. `app-testing` supplies `TestCarContext` so the unit
tests build real stacks under Robolectric. Both artifacts are pinned to one catalog version.

## Alternatives checked

| Alternative                               | Why not                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Kotlin stdlib, JDK, AndroidX already used | None model car templates or screen stacks.                                                               |
| Reflection over the app's car classes     | Untyped, breaks silently across library versions, and would still need the library to test.              |
| `implementation` dependency               | Would add the Car App Library to every SDK consumer, including apps that never target cars.              |
| Reading the host's rendering (DHU, AAOS)  | Out of scope here: the route reports what the app built; host-side verification is a separate epic item. |
