package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Typeface
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * Supplied by [PrototypeRuntimeContent]; null (previews, tests) draws every font asset as default.
 */
internal val LocalPrototypeFontCache = compositionLocalOf<PrototypeFontCache?> { null }

/** Turns a stored font file into a family. Throwing or returning null means "unusable font". */
fun interface PrototypeFontLoader {
  fun load(file: File): FontFamily?
}

/**
 * Loads `FontFamily(Font(file))`. [Typeface.createFromFile] is called first because Compose
 * resolves fonts lazily and `Typeface` silently answers the default face for a file it cannot
 * parse, which would hide a corrupt upload; the check turns that into a logged fallback. Needs real
 * Android font parsing, so it is verified on a device; the caching and fallback logic around it is
 * unit tested with a fake loader.
 */
class ComposePrototypeFontLoader : PrototypeFontLoader {
  override fun load(file: File): FontFamily? {
    val typeface = Typeface.createFromFile(file)
    return if (typeface == null || typeface === Typeface.DEFAULT) null else FontFamily(Font(file))
  }
}

/**
 * Loaded custom fonts, keyed by asset id and loaded once per asset: a successful load and a failed
 * one are both remembered, so a corrupt font logs one warning rather than one per frame. When the
 * store reports a replaced, removed or cleared asset the entry is dropped and [version] moves so
 * composables showing it reload. [resolve] returns null for an unknown asset, an unreadable file or
 * a font that failed to load; the caller then draws the default family. An unknown asset is not
 * cached, so uploading it later is picked up without waiting for an invalidation.
 *
 * The cache lock is never held while calling [source] or [loader].
 */
class PrototypeFontCache(
  private val source: PrototypeAssetSource,
  private val loader: PrototypeFontLoader,
  private val warn: (String, Throwable?) -> Unit = { message, error -> Log.w(TAG, message, error) },
) {
  private val lock = Any()
  // A null value is a remembered load failure.
  private val loaded = HashMap<String, FontFamily?>()
  private var epoch = 0L
  private val mutableVersion = MutableStateFlow(0L)

  /** Moves on every invalidation; key composables on it so they reload a changed font. */
  val version: StateFlow<Long> = mutableVersion

  fun resolve(assetId: String): FontFamily? {
    val startEpoch =
      synchronized(lock) {
        if (loaded.containsKey(assetId)) return loaded[assetId]
        epoch
      }
    val file = source.file(assetId) ?: return null
    val family = loadOrNull(file)
    synchronized(lock) { if (epoch == startEpoch) loaded[assetId] = family }
    return family
  }

  private fun loadOrNull(file: File): FontFamily? =
    try {
      loader.load(file).also {
        if (it == null)
          warn("Prototype font asset could not be loaded; using the default font", null)
      }
    } catch (error: RuntimeException) {
      warn("Prototype font asset failed to load; using the default font", error)
      null
    }

  /** Matches [PrototypeAssetChangeListener]: null means every asset. */
  fun invalidate(ids: Set<String>?) {
    synchronized(lock) {
      epoch++
      if (ids == null) loaded.clear() else ids.forEach(loaded::remove)
    }
    mutableVersion.update { it + 1 }
  }

  private companion object {
    const val TAG = "PrototypeFontCache"
  }
}

/** The family to draw [style] with: its font asset when loadable, else the built-in fallback. */
@Composable
internal fun rememberPrototypeFontFamily(style: PrototypeRenderStyle): FontFamily {
  val assetId = style.fontAsset ?: return style.fontFamily
  val cache = LocalPrototypeFontCache.current ?: return style.fontFamily
  val version by cache.version.collectAsState()
  return remember(cache, assetId, version) { cache.resolve(assetId) } ?: style.fontFamily
}
