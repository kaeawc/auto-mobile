# Navigation API Surface Alignment

Status: implemented

## Shared Concepts and Wire Values

These navigation sources exist on both platforms and use identical wire format strings:

| Concept   | Wire Value  | Android Enum | iOS Enum   |
| --------- | ----------- | ------------ | ---------- |
| Deep link | `deep_link` | `DEEP_LINK`  | `deepLink` |
| Custom    | `custom`    | `CUSTOM`     | `custom`   |

## Platform-Specific Sources

### Android Only

| Wire Value             | Enum                   | Description                        |
| ---------------------- | ---------------------- | ---------------------------------- |
| `navigation_component` | `NAVIGATION_COMPONENT` | Jetpack Navigation Component (XML) |
| `compose_navigation`   | `COMPOSE_NAVIGATION`   | Jetpack Compose Navigation         |
| `circuit`              | `CIRCUIT`              | Circuit navigation library         |
| `activity`             | `ACTIVITY`             | Activity launch                    |

### iOS Only

| Wire Value           | Enum                | Description                  |
| -------------------- | ------------------- | ---------------------------- |
| `swiftui_navigation` | `swiftUINavigation` | SwiftUI NavigationStack/Path |
| `uikit_navigation`   | `uiKitNavigation`   | UIKit UINavigationController |

## NavigationEvent Fields

Both platforms expose the same fields with compatible types:

| Field         | Android Type          | iOS Type           | Notes                                                     |
| ------------- | --------------------- | ------------------ | --------------------------------------------------------- |
| `destination` | `String`              | `String`           | Exact match                                               |
| `source`      | `NavigationSource`    | `NavigationSource` | Aligned via wire values                                   |
| `timestamp`   | `Long` (epoch ms)     | `Int64` (epoch ms) | Both default to current time in ms                        |
| `arguments`   | `Map<String, Any?>`   | `[String: String]` | iOS stringifies; convenience init accepts `[String: Any]` |
| `metadata`    | `Map<String, String>` | `[String: String]` | Exact match                                               |

## Wire Format Convention

- Android: `NavigationSource.wireValue` property (lowercase snake_case)
- iOS: `NavigationSource.rawValue` (lowercase snake_case, String-backed enum)
- Android enum names remain idiomatic SCREAMING_SNAKE_CASE
- iOS enum names remain idiomatic camelCase

## Mismatches Found and Fixed

1. **Android had no wire format values.** The Kotlin enum relied on `.name` (SCREAMING_SNAKE_CASE)
   which did not match iOS `.rawValue` (lowercase snake_case). Fixed by adding a `wireValue`
   constructor parameter and a `fromWireValue()` companion method.

2. **iOS `custom` case lacked an explicit raw value.** While Swift infers `"custom"` for a
   `String`-backed enum, this was made explicit to signal the cross-platform contract.
