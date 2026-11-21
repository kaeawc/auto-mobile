plugins { `kotlin-dsl` }

// Precompiled convention plugins need the Kotlin Gradle plugin, AGP, and the
// detekt plugin on the classpath so they can reference KotlinCompile, the Android
// extensions, and DetektExtension. The Kotlin DSL compiles on the build's JDK;
// pin its toolchain to the project's Java target for consistency.
kotlin { jvmToolchain(libs.versions.build.java.target.get().toInt()) }

dependencies {
  implementation(libs.kgp)
  implementation(libs.agp)
  implementation(libs.androidx.baselineprofile.gradle.plugin)
  implementation(libs.mavenPublishPlugin)
  implementation("dev.detekt:detekt-gradle-plugin:${libs.versions.detekt.get()}")
  testImplementation(libs.junit)
}

// ProtoViewerVersioningTest reads the version vectors it shares with the MCP host (#14156).
tasks.withType<Test>().configureEach {
  inputs
    .file(layout.projectDirectory.file("../../test/fixtures/protoviewer-version-codes.txt"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("protoViewerVersionCodes")
}
