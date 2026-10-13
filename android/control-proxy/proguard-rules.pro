# Rules apply only with -Pautomobile.ctrlproxy.minifyRelease=true; CI's JVM Consumer Checks
# uses it so the rules and kept-class verifier cannot rot. Default-on is gated on minified-APK
# device checks (#12129): coroutine/Ktor atomic updaters rewritten to sun.misc.Unsafe on API 24/36;
# Ktor CIO bind/accept and a long-lived WebSocket; accessibility service, IME and device-admin
# binding; prototype icon lookup for all five styles; decode-failure wire messages; SDK event
# batch decode and storage requests; baseline-profile install.
# Open-source adb-sideloaded tool: wire errors, host component names and crash stacks need names.
# Shrinking and optimization are enabled when opted in.
-dontobfuscate

# Class and member names are preserved; original file names and line numbers need retrace with
# build/outputs/mapping/release/mapping.txt. Retain annotations and generic/nested-class metadata.
-keepattributes SourceFile,LineNumberTable,*Annotation*,InnerClasses,EnclosingMethod,Signature

# Prototype icons are resolved by name through reflection (PrototypeIcons.kt).
-keep class androidx.compose.material.icons.** { *; }

# Wire models span CtrlProxy, protocol and SDK; preserve their serialization contracts.
-keep @kotlinx.serialization.Serializable class dev.jasonpearson.automobile.** { *; }
# Generated serializers and companion entry points are also accessed by serialization machinery.
-keep class dev.jasonpearson.automobile.**$$serializer { *; }
-keepclassmembers class dev.jasonpearson.automobile.** {
    *** Companion;
    *** serializer(...);
}

# Explicit host-addressed manifest entry points supplement AAPT's generated rules.
-keep class dev.jasonpearson.automobile.ctrlproxy.MainActivity { *; }
-keep class dev.jasonpearson.automobile.ctrlproxy.CtrlProxy { *; }
-keep class dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme { *; }
-keep class dev.jasonpearson.automobile.ctrlproxy.AutoMobileDeviceAdminReceiver { *; }

# Retain any owned component a library manifest merges in later.
-keep class dev.jasonpearson.automobile.** extends android.app.Service { *; }
-keep class dev.jasonpearson.automobile.** extends android.content.BroadcastReceiver { *; }
-keep class dev.jasonpearson.automobile.** extends android.content.ContentProvider { *; }
-keep class dev.jasonpearson.automobile.** extends android.app.Activity { *; }

# Ktor, coroutines, kotlinx.serialization and OkHttp supply their own consumer rules.
# Missing-class suppressions (R8 diagnostics)
# Circuit is an optional SDK compileOnly integration (consumer-kept sdk.adapters.CircuitAdapter) CtrlProxy never calls.
-dontwarn com.slack.circuit.runtime.screen.Screen
-dontwarn com.slack.circuitx.navigation.intercepting.NavigationEventListener
# Ktor's JVM-only IntellijIdeaDebugDetector references java.lang.management inside a catch-all.
-dontwarn java.lang.management.ManagementFactory
-dontwarn java.lang.management.RuntimeMXBean
