// On-device generator for CtrlProxy's baseline profile (#17417). It needs a connected device or
// emulator (API 33+, or rooted API 28+), so CI never runs it. Regenerate with
// `./gradlew :control-proxy:generateBaselineProfile`; the plugin writes the rules to
// control-proxy/src/main/generated/baselineProfiles/, which the release APK packages next to the
// hand-authored src/main/baseline-prof.txt.
plugins {
  id("automobile.android-baseline-profile-generator")
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.ctrlproxy.baselineprofile"
  targetProjectPath = ":control-proxy"
}

baselineProfile { useConnectedDevices = true }

dependencies {
  implementation(projects.protocol)
  implementation(libs.androidx.junit)
  implementation(libs.androidx.benchmark.macro.junit4)
  implementation(libs.kotlinx.serialization)
  implementation(libs.okhttp)
}
