package dev.jasonpearson.automobile.automotivefixture.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Template
import dev.jasonpearson.automobile.sdk.carapp.AutoMobileCarAppTemplates

internal object CarTemplateRecorderFactory {
  val recorder: CarTemplateRecorder =
    object : CarTemplateRecorder {
      override fun enable(carContext: CarContext) {
        AutoMobileCarAppTemplates.enable(carContext)
      }

      override fun <T : Template> record(screen: Screen, template: T): T =
        AutoMobileCarAppTemplates.record(screen, template)
    }
}
