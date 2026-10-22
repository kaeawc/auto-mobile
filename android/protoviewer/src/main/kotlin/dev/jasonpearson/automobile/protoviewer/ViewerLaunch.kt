package dev.jasonpearson.automobile.protoviewer

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri

object ViewerLaunch {
  const val LIBRARY_ID = "libraryId"

  fun open(context: Context, libraryId: String, relaunch: Boolean = false) {
    val tasks =
      context.getSystemService(ActivityManager::class.java).appTasks.filter {
        val base = it.taskInfo?.baseIntent
        base?.component?.className == ViewerActivity::class.java.name &&
          base.getStringExtra(LIBRARY_ID) == libraryId
      }
    if (!relaunch && tasks.isNotEmpty()) {
      tasks.first().moveToFront()
      return
    }
    // Also remove a restored document whose old process no longer has a registered viewer.
    tasks.forEach { it.finishAndRemoveTask() }
    context.startActivity(intent(context, libraryId))
  }

  fun close(context: Context, libraryId: String) {
    context
      .getSystemService(ActivityManager::class.java)
      .appTasks
      .filter {
        it.taskInfo?.baseIntent?.component?.className == ViewerActivity::class.java.name &&
          it.taskInfo?.baseIntent?.getStringExtra(LIBRARY_ID) == libraryId
      }
      .forEach { it.finishAndRemoveTask() }
  }

  fun intent(context: Context, libraryId: String): Intent =
    Intent(context, ViewerActivity::class.java)
      .putExtra(LIBRARY_ID, libraryId)
      .setData(Uri.Builder().scheme("automobile-protoviewer").appendPath(libraryId).build())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
}
