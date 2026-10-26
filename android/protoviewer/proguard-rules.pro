# No app-specific shrinker rules.

# ProtoViewer renders any prototype, so any contract icon name can arrive at runtime and is resolved
# by reflection (PrototypeIcons.kt). The :prototype-compose library no longer ships this keep rule.
-keep class androidx.compose.material.icons.** { *; }
