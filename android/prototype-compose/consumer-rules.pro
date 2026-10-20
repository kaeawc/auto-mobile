# Prototype icons are resolved by name through reflection (PrototypeIcons.kt).
-keep class androidx.compose.material.icons.** { *; }
# The request service is only reached through Retrofit's runtime proxy.
-keep interface dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpService { *; }
