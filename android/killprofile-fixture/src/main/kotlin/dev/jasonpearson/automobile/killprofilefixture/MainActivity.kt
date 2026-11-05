package dev.jasonpearson.automobile.killprofilefixture

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Button
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import java.io.File
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(
      Button(this).apply {
        setText(R.string.start_schedules)
        setOnClickListener { startSchedules() }
      },
    )
    if (savedInstanceState == null && intent.getBooleanExtra("autoStart", false)) startSchedules()
  }

  private fun startSchedules() {
    startForegroundService(Intent(this, SurvivalForegroundService::class.java))
    Thread {
      try {
        schedule()
      } catch (error: ExecutionException) {
        recordScheduleFailure(error)
      } catch (error: InterruptedException) {
        recordScheduleFailure(error)
      } catch (error: SecurityException) {
        recordScheduleFailure(error)
      } catch (error: IllegalStateException) {
        recordScheduleFailure(error)
      }
    }
      .start()
  }

  private fun recordScheduleFailure(error: Throwable) {
    Log.e("SurvivalFixture", "Scheduling failed", error)
    File(filesDir, "survival-error").writeText(error.toString())
  }

  private fun schedule() {
    val start = System.currentTimeMillis()
    File(filesDir, "survival-events.log").writeText("")
    val manager = WorkManager.getInstance(this)
    manager.cancelAllWork().result.get()
    val periodic =
      PeriodicWorkRequest.Builder(SurvivalWorker::class.java, 15, TimeUnit.MINUTES)
        .setInitialDelay(15, TimeUnit.MINUTES)
        .setInputData(eventData(SurvivalEventId.WORKMANAGER_PERIODIC))
        .build()
    val oneshot =
      OneTimeWorkRequest.Builder(SurvivalWorker::class.java)
        .setInitialDelay(1, TimeUnit.MINUTES)
        .setInputData(eventData(SurvivalEventId.WORKMANAGER_ONESHOT))
        .build()
    manager
      .enqueueUniquePeriodicWork("survival-periodic", ExistingPeriodicWorkPolicy.UPDATE, periodic)
      .result
      .get()
    manager.enqueueUniqueWork("survival-oneshot", ExistingWorkPolicy.REPLACE, oneshot).result.get()
    val job =
      JobInfo.Builder(1, ComponentName(this, SurvivalJobService::class.java))
        .setMinimumLatency(FIRST_WORK_MS)
        .setOverrideDeadline(2 * FIRST_WORK_MS)
        .build()
    check(getSystemService(JobScheduler::class.java).schedule(job) == JobScheduler.RESULT_SUCCESS)
    val alarms = getSystemService(AlarmManager::class.java)
    check(alarms.canScheduleExactAlarms()) { "SCHEDULE_EXACT_ALARM not granted" }
    alarms.setExactAndAllowWhileIdle(
      AlarmManager.RTC_WAKEUP,
      start + FIRST_WORK_MS,
      alarmIntent(SurvivalEventId.ALARM_EXACT, 1),
    )
    alarms.set(
      AlarmManager.RTC_WAKEUP,
      start + FIRST_WORK_MS,
      alarmIntent(SurvivalEventId.ALARM_INEXACT, 2),
    )
    // A separate ready marker lets the host wait for committed WorkManager requests before killing.
    File(filesDir, "survival-ready").writeText(start.toString())
  }

  private fun eventData(event: SurvivalEventId): Data =
    Data.Builder().putString("event", event.name).build()

  private fun alarmIntent(event: SurvivalEventId, requestCode: Int): PendingIntent =
    PendingIntent.getBroadcast(
      this,
      requestCode,
      Intent(this, AlarmReceiver::class.java).putExtra("event", event.name),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private companion object {
    const val FIRST_WORK_MS = 60_000L
  }
}
