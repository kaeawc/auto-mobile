# ProtoViewer is shrunk and obfuscated for Play. The R8 mapping ships inside the AAB and is archived
# per versionCode (archiveProtoViewerReleaseMapping), so stack traces can be de-obfuscated later.
-keepattributes SourceFile,LineNumberTable,*Annotation*,InnerClasses,EnclosingMethod,Signature

# ProtoViewer renders any prototype, so any contract icon name can arrive at runtime and is resolved
# by reflection (PrototypeIcons.kt). The :prototype-compose library no longer ships this keep rule.
-keep class androidx.compose.material.icons.** { *; }

# The saved-prototype contract is persisted and exchanged as JSON; keep its models and generated
# serializers intact (verifyReleaseR8KeptClasses asserts it).
-keep @kotlinx.serialization.Serializable class dev.jasonpearson.automobile.ctrlproxy.prototype.** { *; }
-keep class dev.jasonpearson.automobile.ctrlproxy.prototype.**$$serializer { *; }
-keepclassmembers class dev.jasonpearson.automobile.ctrlproxy.prototype.** {
    *** Companion;
    *** serializer(...);
}

# The prototype request service is only ever reached through Retrofit's runtime proxy, so its
# annotated methods must survive shrinking. Retrofit and OkHttp supply their own consumer rules.
-keep interface dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpService { *; }
