# AutoMobile SDK Consumer ProGuard Rules

# Preserve source file names and line numbers for readable crash reports
-keepattributes SourceFile,LineNumberTable

# Keep public API entry points
-keep public class dev.jasonpearson.automobile.sdk.AutoMobileSDK { public *; }
-keep public class dev.jasonpearson.automobile.sdk.NavigationEvent { *; }
-keep public class dev.jasonpearson.automobile.sdk.NavigationListener { *; }
-keep public class dev.jasonpearson.automobile.sdk.NavigationSource { *; }

# Keep crash/failure/ANR public APIs
-keep public class dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes { public *; }
-keep public class dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures { public *; }
-keep public class dev.jasonpearson.automobile.sdk.failures.HandledExceptionEvent { *; }
-keep public class dev.jasonpearson.automobile.sdk.failures.DeviceInfo { *; }
-keep public class dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr { public *; }

# Keep navigation framework adapters (used via Compose)
-keep public class dev.jasonpearson.automobile.sdk.adapters.** { public *; }

# Keep public interfaces (NavigationListener, etc.)
-keep public interface dev.jasonpearson.automobile.sdk.** { *; }

# Keep network interception (consumers may reference interceptor/listener)
-keep public class dev.jasonpearson.automobile.sdk.network.** { public *; }

# Keep interaction tracking
-keep public class dev.jasonpearson.automobile.sdk.interaction.** { public *; }

# Keep protocol serialization classes (kotlinx.serialization requires these)
-keepclassmembers class dev.jasonpearson.automobile.protocol.** {
    *;
}

# Keep Kotlin serialization infrastructure
-keepattributes *Annotation*
-keep class kotlinx.serialization.** { *; }
-keepclassmembers class * {
    @kotlinx.serialization.Serializable <fields>;
}
