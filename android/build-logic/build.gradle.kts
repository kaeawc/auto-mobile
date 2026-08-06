plugins { `kotlin-dsl` }

// Precompiled convention plugins need the Kotlin Gradle plugin on the classpath so
// they can reference KotlinCompile / the kotlin extension. The Kotlin DSL compiles
// on the build's JDK; pin its toolchain to the project's Java target for consistency.
kotlin { jvmToolchain(libs.versions.build.java.target.get().toInt()) }

dependencies { implementation(libs.kgp) }
