import androidx.baselineprofile.gradle.consumer.BaselineProfileConsumerExtension
import org.gradle.kotlin.dsl.configure

// App side of a baseline profile: applies `androidx.baselineprofile` to an application module and
// packages the rules its producer (an automobile.android-baseline-profile-generator module, added
// with `baselineProfile(...)`) writes to src/main/generated/baselineProfiles/. Those rules are
// merged with any hand-authored src/main/baseline-prof.txt into the release APK's
// assets/dexopt/baseline.prof. Generation needs a connected device, so a build never runs it;
// regenerate with `./gradlew :<app>:generateBaselineProfile`.
pluginManager.apply("androidx.baselineprofile")

extensions.configure<BaselineProfileConsumerExtension> {
  mergeIntoMain = true
  automaticGenerationDuringBuild = false
}
