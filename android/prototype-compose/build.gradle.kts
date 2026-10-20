import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar

plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.mavenPublish)
  id("automobile.published-library")
}

android {
  namespace = "dev.jasonpearson.automobile.prototype"

  defaultConfig { testInstrumentationRunner = null }

  buildFeatures { compose = true }
}

kotlin {
  compilerOptions {
    optIn.add("dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi")
  }
}

dependencies {
  // Spec, action and validation types are part of this library's API.
  api(projects.protocol)

  api(platform(libs.compose.bom))
  api(libs.compose.ui.core)
  implementation(libs.androidx.core)
  implementation(libs.androidx.activity.compose)
  implementation(libs.compose.ui.util)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.ui.foundation)
  implementation(libs.compose.material)
  implementation(libs.compose.material.icons.extended)
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)

  // `request` actions with `via: "device"` (see docs/decisions/prototype-request-retrofit.md).
  implementation(libs.okhttp)
  implementation(libs.retrofit)

  testImplementation(libs.bundles.unit.test)
}

mavenPublishing {
  // Same Central-compliant empty Javadoc jar as the SDK (#4852); the sources jar is real.
  configure(AndroidSingleVariantLibrary(javadocJar = JavadocJar.Empty()))
}
