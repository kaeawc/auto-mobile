package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

fun interface PrototypeWebDataWiper {
  suspend fun wipe()
}

internal class AndroidPrototypeWebDataWiper(
  private val context: Context,
  private val io: CoroutineDispatcher = Dispatchers.IO,
) : PrototypeWebDataWiper {
  override suspend fun wipe() =
    withContext(Dispatchers.Main.immediate) {
      // Framework WebView storage is shared by this process; this app uses no per-prototype
      // profile.
      WebStorage.getInstance().deleteAllData()
      val view = WebView(context)
      try {
        view.clearCache(true)
        view.clearHistory()
      } finally {
        view.destroy()
      }
      val cookies = CookieManager.getInstance()
      suspendCoroutine { continuation ->
        cookies.removeAllCookies { continuation.resume(Unit) }
      }
      withContext(io) { cookies.flush() }
    }
}
