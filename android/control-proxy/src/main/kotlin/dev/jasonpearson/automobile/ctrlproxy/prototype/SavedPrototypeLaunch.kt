package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Explicit SavedPrototypeActivity component, data automobile-saved-prototype:/<encoded id>, and
 * FLAG_ACTIVITY_NEW_DOCUMENT. No extras are read: only the id selects app-private saved content.
 * Data, rather than extras, gives documentLaunchMode=intoExisting one task per prototype because
 * Intent.filterEquals ignores extras. Shortcut publishers may supply their own additional flags.
 */
object SavedPrototypeLaunch {
  private const val SCHEME = "automobile-saved-prototype"

  fun intent(context: Context, id: String): Intent =
    Intent(context, SavedPrototypeActivity::class.java)
      .setData(Uri.Builder().scheme(SCHEME).appendPath(id).build())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)

  fun idFrom(intent: Intent?): String? {
    val data = intent?.data ?: return null
    if (data.scheme != SCHEME || !data.authority.isNullOrEmpty()) return null
    if (data.query != null || data.fragment != null) return null
    val id = data.pathSegments.singleOrNull()?.takeIf { it.isNotBlank() } ?: return null
    return id.takeIf { data.encodedPath == Uri.Builder().appendPath(id).build().encodedPath }
  }
}
