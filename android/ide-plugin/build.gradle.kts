import org.jetbrains.intellij.platform.gradle.extensions.intellijPlatform

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  kotlin("plugin.compose")
  id("org.jetbrains.intellij.platform") version "2.18.1"
  // Note: Using IntelliJ Platform's composeUI() instead of standalone org.jetbrains.compose
  // to avoid bundling duplicate coroutines that conflict with IDE's version
}

repositories {
  google()
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

java {
  toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get())) }
}

sourceSets {
  named("main") { resources.srcDir(rootProject.projectDir.parentFile.resolve("schemas")) }
}

dependencies {
  // Shared module (UX, unix socket architecture, settings, data sources)
  // Exclude coroutines and Compose runtime since IntelliJ provides them
  implementation(project(":desktop-core")) {
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
    exclude(group = "org.jetbrains.compose.runtime")
    exclude(group = "org.jetbrains.compose.ui")
    exclude(group = "org.jetbrains.compose.foundation")
    exclude(group = "org.jetbrains.compose.material3")
  }

  // Shared validation module
  implementation(project(":test-plan-validation"))

  // Kotlin ecosystem (provided by IntelliJ platform, don't bundle)
  compileOnly(libs.kotlinx.coroutines)
  compileOnly(libs.kotlinx.serialization)

  // YAML parsing is used directly; schema validation comes from test-plan-validation.
  implementation(libs.snakeyaml)

  // Test dependencies
  testImplementation("junit:junit:4.13.2")
  testImplementation(libs.kotlin.test)
  testImplementation(libs.kotlinx.coroutines.test)

  intellijPlatform {
    intellijIdea("2025.3")
    bundledPlugin("com.intellij.java")
    bundledPlugin("org.jetbrains.plugins.yaml")
    composeUI()
    pluginVerifier()
  }
}

private val verifyPluginRequested =
  gradle.startParameter.taskNames.any { it.substringAfterLast(':').startsWith("verifyPlugin") }

private val useRecommendedVerifierIdes =
  providers
    .gradleProperty("automobile.ide.verifierRecommendedIdes")
    .map(String::toBoolean)
    .getOrElse(verifyPluginRequested)

intellijPlatform {
  pluginConfiguration {
    id.set("com.automobile.ide")
    name.set("AutoMobile")
    version.set("0.1.0")
    description.set(
      "AutoMobile IDE integration for authoring tests and visualizing navigation graphs."
    )

    ideaVersion {
      sinceBuild.set("253")
      untilBuild.set("253.*")
    }

    vendor {
      name.set("AutoMobile")
      email.set("support@automobile.dev")
      url.set("https://github.com/kaeawc/auto-mobile")
    }
  }

  // `recommended()` asks JetBrains' product-releases data service
  // (data.services.jetbrains.com) which IDE builds to verify against. The
  // resulting dependency is wired into this project's resolution, so ANY task
  // that resolves :ide-plugin:compileClasspath — `detekt` included — depended on
  // DNS for a host it otherwise has no reason to reach, and a transient
  // UnknownHostException reddened the unrelated Detekt job on main (#6880).
  // Only a build that actually runs `verifyPlugin` needs the lookup, so it is
  // off by default and enabled automatically when that task is requested.
  // Force it either way with -Pautomobile.ide.verifierRecommendedIdes=<bool>.
  if (useRecommendedVerifierIdes) {
    pluginVerification { ides { recommended() } }
  }
}
