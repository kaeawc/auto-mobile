pluginManagement {
  repositories {
    maven {
      url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
      mavenContent { releasesOnly() }
    }
    gradlePluginPortal()
    google()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositories {
    google()
    maven {
      url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
      mavenContent { releasesOnly() }
    }
    mavenCentral()
    gradlePluginPortal()
  }
  // Reuse the root project's single version catalog so convention plugins read the
  // same Kotlin/Java/plugin versions as the modules they configure.
  versionCatalogs { create("libs") { from(files("../gradle/libs.versions.toml")) } }
}

rootProject.name = "build-logic"
