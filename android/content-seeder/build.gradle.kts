plugins { id("automobile.android-application") }

android {
  namespace = "dev.jasonpearson.automobile.contentseeder"
  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.contentseeder"
    versionCode = 1
  }
}

// This fixture must never produce a release APK or bundle.
androidComponents { beforeVariants(selector().all()) { it.enable = it.buildType == "debug" } }

dependencies { testImplementation(libs.junit) }
