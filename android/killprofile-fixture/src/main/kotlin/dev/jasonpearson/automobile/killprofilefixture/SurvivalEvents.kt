package dev.jasonpearson.automobile.killprofilefixture

import android.content.Context
import java.io.File

/** Wire ids must match SURVIVAL_EVENT_IDS in the host scorer. */
enum class SurvivalEventId(val wireId: String) {
  WORKMANAGER_PERIODIC("workmanager-periodic"),
  WORKMANAGER_ONESHOT("workmanager-oneshot"),
  JOBSCHEDULER("jobscheduler"),
  ALARM_EXACT("alarm-exact"),
  ALARM_INEXACT("alarm-inexact"),
  FOREGROUND_SERVICE("foreground-service"),
  BOOT_RECEIVER("boot-receiver"),
  PUSH_BROADCAST("push-broadcast"),
}

internal object SurvivalEvents {
  // All components use the application's default process; serialize concurrent worker callbacks.
  @Synchronized
  fun append(context: Context, event: SurvivalEventId) {
    File(context.filesDir, "survival-events.log")
      .appendText("${event.wireId} ${System.currentTimeMillis()}\n")
  }
}
