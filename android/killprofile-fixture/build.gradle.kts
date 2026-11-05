plugins { id("automobile.android-application") }

android {
  namespace = "dev.jasonpearson.automobile.killprofilefixture"
  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.killprofilefixture"
    minSdk = 31
    versionCode = 1
  }
  buildTypes { getByName("debug") { isDebuggable = true } }
}

dependencies { implementation(libs.androidx.work.runtime) }
