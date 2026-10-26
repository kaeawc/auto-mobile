# Intentionally empty. Prototype icons are resolved by name through reflection (PrototypeIcons.kt),
# but a consumer keep rule for androidx.compose.material.icons.** would retain all of
# material-icons-extended (about 3 MB of dex) in every app that depends on this library (#14149).
# Apps that render icons by name keep the icon classes in their own rules; see
# docs/using/prototype-embedding.md ("Shrinking").
