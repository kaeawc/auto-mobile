package dev.jasonpearson.automobile.killprofilefixture

import android.app.Application
import androidx.work.Configuration

class SurvivalApplication : Application(), Configuration.Provider {
  override val workManagerConfiguration: Configuration
    get() = Configuration.Builder().setJobSchedulerJobIdRange(10_000, 19_999).build()
}
