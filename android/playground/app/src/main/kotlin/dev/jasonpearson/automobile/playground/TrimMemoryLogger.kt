package dev.jasonpearson.automobile.playground

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.util.Log

class TrimMemoryLogger : ComponentCallbacks2 {
  override fun onTrimMemory(level: Int) {
    val name = trimMemoryLevelName(level)
    Log.i("AutoMobileTrimMemory", "onTrimMemory level=$name value=$level")
  }

  override fun onConfigurationChanged(newConfig: Configuration) = Unit

  @Deprecated("Superseded by onTrimMemory since API level 14; never called since API level 34.")
  override fun onLowMemory() = Unit
}

private const val TRIM_MEMORY_RUNNING_MODERATE = 5
private const val TRIM_MEMORY_RUNNING_LOW = 10
private const val TRIM_MEMORY_RUNNING_CRITICAL = 15
private const val TRIM_MEMORY_UI_HIDDEN = 20
private const val TRIM_MEMORY_BACKGROUND = 40
private const val TRIM_MEMORY_MODERATE = 60
private const val TRIM_MEMORY_COMPLETE = 80

internal fun trimMemoryLevelName(level: Int): String =
  when (level) {
    TRIM_MEMORY_RUNNING_MODERATE -> "RUNNING_MODERATE"
    TRIM_MEMORY_RUNNING_LOW -> "RUNNING_LOW"
    TRIM_MEMORY_RUNNING_CRITICAL -> "RUNNING_CRITICAL"
    TRIM_MEMORY_UI_HIDDEN -> "HIDDEN"
    TRIM_MEMORY_BACKGROUND -> "BACKGROUND"
    TRIM_MEMORY_MODERATE -> "MODERATE"
    TRIM_MEMORY_COMPLETE -> "COMPLETE"
    else -> "UNKNOWN($level)"
  }
