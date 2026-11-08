import dev.jasonpearson.automobile.buildlogic.robolectric.RobolectricAndroidAll
import dev.jasonpearson.automobile.buildlogic.robolectric.RobolectricDepsArgumentProvider
import dev.jasonpearson.automobile.buildlogic.robolectric.RobolectricModuleSdksSource
import dev.jasonpearson.automobile.buildlogic.robolectric.WriteRobolectricDepsTask
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.getByType

// Resolve Robolectric's android-all runtime jars through Gradle and run Robolectric offline
// against them (#16802). Robolectric's own downloader hits Maven Central once per jar at test
// time with no retry and no Gradle cache, so a single blip failed every Robolectric class.

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")

RobolectricAndroidAll.requireCatalogVersion(
  libs.findVersion("robolectric").get().requiredVersion,
)

val moduleSdks =
  providers.of(RobolectricModuleSdksSource::class.java) {
    parameters.moduleDir.set(layout.projectDirectory)
  }

// One configuration per SDK: every jar is a different version of the same module, so a single
// configuration would conflict-resolve them down to the newest one.
val robolectricAndroidAll =
  RobolectricAndroidAll.versions.keys.map { sdk ->
    configurations.create("robolectricAndroidAll$sdk") {
      description = "Robolectric android-all-instrumented $sdk runtime jar for this module's tests."
      isCanBeConsumed = false
      isCanBeResolved = true
      isTransitive = false
      dependencies.addAllLater(
        moduleSdks.map { sdks ->
          listOfNotNull(RobolectricAndroidAll.coordinate(sdk).takeIf { sdk in sdks }).map {
            project.dependencies.create(it)
          }
        },
      )
    }
  }

val robolectricJars = files(robolectricAndroidAll)

val writeRobolectricDeps =
  tasks.register<WriteRobolectricDepsTask>("writeRobolectricDeps") {
    jars.from(robolectricJars)
    depsFile.set(layout.buildDirectory.file("robolectric/robolectric-deps.properties"))
  }

tasks.withType<Test>().configureEach {
  dependsOn(writeRobolectricDeps)
  jvmArgumentProviders.add(
    RobolectricDepsArgumentProvider(
      writeRobolectricDeps.flatMap { it.depsFile },
      robolectricJars,
    ),
  )
}
