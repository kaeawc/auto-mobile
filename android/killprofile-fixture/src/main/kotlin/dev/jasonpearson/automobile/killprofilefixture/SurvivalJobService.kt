package dev.jasonpearson.automobile.killprofilefixture

import android.app.job.JobParameters
import android.app.job.JobService

class SurvivalJobService : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    SurvivalEvents.append(this, SurvivalEventId.JOBSCHEDULER)
    return false
  }

  override fun onStopJob(params: JobParameters): Boolean = true
}
