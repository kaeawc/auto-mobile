package dev.jasonpearson.automobile.prototype.appshell

import android.content.res.AssetManager
import android.util.Log
import java.io.FileNotFoundException
import java.io.IOException

/** All payload files are supplied by the stamper, never by launch-intent extras. */
internal class ApkPrototypeSource(private val assets: AssetManager) : AppSpecSource {
  override fun readSpec(): String? =
    try {
      assets.open("prototype/spec.json").bufferedReader(Charsets.UTF_8).use { it.readText() }
    } catch (error: FileNotFoundException) {
      Log.w("PrototypeAppShell", "Stamped prototype spec is missing", error)
      null
    }

  fun readAsset(id: String): ByteArray? =
    try {
      assets.open("prototype/assets/$id").use { it.readBytes() }
    } catch (error: IOException) {
      // Optional assets use the renderer's missing-image/default-font fallback.
      Log.w("PrototypeAppShell", "Optional prototype asset unavailable", error)
      null
    }
}
