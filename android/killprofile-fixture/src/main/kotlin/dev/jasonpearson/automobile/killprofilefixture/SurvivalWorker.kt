package dev.jasonpearson.automobile.killprofilefixture

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class SurvivalWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val event = SurvivalEventId.valueOf(requireNotNull(inputData.getString("event")))
    SurvivalEvents.append(applicationContext, event)
    return Result.success()
  }
}
