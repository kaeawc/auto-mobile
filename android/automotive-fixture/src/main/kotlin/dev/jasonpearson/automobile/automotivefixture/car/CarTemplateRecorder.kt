package dev.jasonpearson.automobile.automotivefixture.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Template

/** Build variants supply SDK recording without putting the SDK on the release classpath. */
interface CarTemplateRecorder {
  fun enable(carContext: CarContext) {}

  fun <T : Template> record(screen: Screen, template: T): T = template
}
