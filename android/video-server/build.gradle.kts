import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  `java-library`
}

java {
  toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get())) }
}

// Android SDK android.jar as compileOnly dependency for Android APIs
val androidSdkPath: String =
  System.getenv("ANDROID_HOME")
    ?: System.getenv("ANDROID_SDK_ROOT")
    ?: "${System.getProperty("user.home")}/Library/Android/sdk"

val compileSdk: String = libs.versions.build.android.compileSdk.get()
val buildToolsVersion: String = libs.versions.build.android.buildTools.get()
val minSdk: String = libs.versions.build.android.minSdk.get()
val androidPlatformJar: File =
  listOf(
      File("$androidSdkPath/platforms/android-$compileSdk/android.jar"),
      File("$androidSdkPath/platforms/android-$compileSdk.0/android.jar"),
    )
    .firstOrNull { it.exists() }
    ?: error("Unable to find android.jar for compileSdk $compileSdk in $androidSdkPath/platforms")

dependencies {
  compileOnly(files(androidPlatformJar))
  testImplementation(libs.junit)
}

// Configure Kotlin compilation options
tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    languageVersion.set(
      KotlinVersion.valueOf("KOTLIN_${libs.versions.build.kotlin.language.get().replace(".", "_")}")
    )
  }
}

// Custom task to compile the module + its runtime classpath to a DEX jar using d8.
//
// d8 must dex EVERY runtime class the server touches, not just the module's own
// jar: `app_process` provides only the Android framework, so omitting the Kotlin
// stdlib made the server crash instantly with `NoClassDefFoundError:
// kotlin.jvm.internal.Intrinsics` (issue #3776). We feed the full runtime
// classpath and emit a `.jar` so d8 can spill into multiple dex files
// (classes.dex, classes2.dex, ...) without silently dropping any — `app_process`
// loads dex straight from the jar via CLASSPATH.
abstract class D8DexTask @Inject constructor(private val execOperations: ExecOperations) :
  DefaultTask() {

  @get:InputFiles abstract val inputFiles: ConfigurableFileCollection

  @get:OutputFile abstract val outputJar: RegularFileProperty

  @get:Input abstract val d8Path: Property<String>

  @get:Input abstract val minSdkVersion: Property<String>

  @TaskAction
  fun execute() {
    outputJar.get().asFile.parentFile.mkdirs()

    execOperations.exec {
      commandLine(
        buildList {
          add(d8Path.get())
          // Compile without debug dex info (line tables, local-variable data). d8 defaults to
          // --debug; the server is launched via `app_process` from adb shell and is never attached
          // to a jdwp debugger on-device, so the debug info has no consumer and only bloats the
          // jar and its `adb push` payload.
          add("--release")
          add("--output")
          add(outputJar.get().asFile.absolutePath)
          add("--min-api")
          add(minSdkVersion.get())
          // Dex the module jar together with the whole runtime classpath
          // (kotlin-stdlib, etc.). android.jar stays compileOnly, so it is not
          // here and is not dexed — the framework provides it at runtime.
          addAll(inputFiles.files.map { it.absolutePath })
        }
      )
    }
  }
}

tasks.register<D8DexTask>("d8Dex") {
  group = "build"
  description = "Compile the module and its runtime classpath to a DEX jar using d8"

  dependsOn(tasks.jar)

  inputFiles.from(tasks.jar.flatMap { it.archiveFile })
  inputFiles.from(configurations.runtimeClasspath)
  outputJar.set(layout.buildDirectory.file("libs/automobile-video.jar"))
  d8Path.set("$androidSdkPath/build-tools/$buildToolsVersion/d8")
  minSdkVersion.set(minSdk)
}
