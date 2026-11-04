package dev.jasonpearson.automobile.automotivefixture.car

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/** Entry point the templates host binds to. Opens on [TemplateMenuScreen]. */
class FixtureCarAppService : CarAppService() {
  // A test fixture installed only on emulators: accept every templates host, including the AOSP
  // host on non-Play images, so the fixture does not depend on a signing allow-list.
  override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

  override fun onCreateSession(): Session =
    object : Session() {
      override fun onCreateScreen(intent: Intent): Screen = TemplateMenuScreen(carContext)
    }
}
