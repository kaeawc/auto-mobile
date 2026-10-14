package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException

fun interface ShortcutIntentFactory {
  fun intentFor(id: String): Intent
}

/**
 * Once the viewer lands, use SavedPrototypeLaunch.intent(context,
 * id).setAction(Intent.ACTION_VIEW).
 */
class SavedPrototypeShortcutIntents(private val context: Context) : ShortcutIntentFactory {
  override fun intentFor(id: String): Intent =
    Intent()
      .setClassName(
        context.packageName,
        "dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeActivity",
      )
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.Builder().scheme("automobile-saved-prototype").appendPath(id).build())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
}

fun interface ShortcutIconRenderer {
  fun render(iconBytes: ByteArray?, label: String): Bitmap
}

internal object ShortcutIconGeometry {
  fun sizePx(density: Float, maxW: Int, maxH: Int): Int =
    min((108 * density).roundToInt(), min(maxW, maxH)).coerceAtLeast(1)

  /** Coordinates of the centered square: left/top and right/bottom. */
  fun safeZone(size: Int): Pair<Float, Float> {
    val inset = size * (18f / 108f)
    return inset to size - inset
  }
}

class AndroidShortcutIconRenderer(private val context: Context) : ShortcutIconRenderer {
  override fun render(iconBytes: ByteArray?, label: String): Bitmap {
    val edge =
      ShortcutIconGeometry.sizePx(
        context.resources.displayMetrics.density,
        ShortcutManagerCompat.getIconMaxWidth(context),
        ShortcutManagerCompat.getIconMaxHeight(context),
      )
    val bitmap = Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val (start, end) = ShortcutIconGeometry.safeZone(edge)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    val decoded = iconBytes?.let { decode(it, edge) }
    if (decoded != null) {
      try {
        canvas.drawColor(decoded.getPixel(0, 0) or (0xff shl 24))
        val side = min(decoded.width, decoded.height)
        val left = (decoded.width - side) / 2
        val top = (decoded.height - side) / 2
        canvas.drawBitmap(
          decoded,
          Rect(left, top, left + side, top + side),
          RectF(start, start, end, end),
          paint,
        )
      } finally {
        decoded.recycle()
      }
    } else {
      val palette =
        intArrayOf(0xff1565c0.toInt(), 0xff6a1b9a.toInt(), 0xff00695c.toInt(), 0xffc62828.toInt())
      canvas.drawColor(palette[Math.floorMod(label.hashCode(), palette.size)])
      val letter =
        if (label.isBlank()) "?"
        else String(Character.toChars(label.codePointAt(0))).uppercase(java.util.Locale.ROOT)
      paint.color = Color.WHITE
      paint.textAlign = Paint.Align.CENTER
      paint.textSize = (end - start) * 0.65f
      val metrics = paint.fontMetrics
      canvas.drawText(letter, edge / 2f, edge / 2f - (metrics.ascent + metrics.descent) / 2, paint)
    }
    return bitmap
  }

  private fun decode(bytes: ByteArray, edge: Int): Bitmap? {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    if (options.outWidth <= 0 || options.outHeight <= 0) return null
    var sample = 1
    while (
      maxOf(options.outWidth, options.outHeight).toLong() > edge.toLong() * 2 * sample
    ) sample *= 2
    options.inJustDecodeBounds = false
    options.inSampleSize = sample
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
  }
}

class AndroidPinnedShortcutPlatform(
  private val context: Context,
  private val intents: ShortcutIntentFactory = SavedPrototypeShortcutIntents(context),
  private val icons: ShortcutIconRenderer = AndroidShortcutIconRenderer(context),
) : PinnedShortcutPlatform {
  override fun isRequestPinSupported(): Boolean =
    Build.VERSION.SDK_INT >= 26 &&
      logged { ShortcutManagerCompat.isRequestPinShortcutSupported(context) }

  override fun pinnedIds(): Set<String> =
    if (Build.VERSION.SDK_INT < 26) emptySet()
    else
      logged {
        ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
          .map { it.id }
          .toSet()
      }

  override fun requestPin(shortcut: PrototypeShortcut): Boolean =
    if (Build.VERSION.SDK_INT < 26) false
    else logged { ShortcutManagerCompat.requestPinShortcut(context, info(shortcut), null) }

  override fun update(shortcut: PrototypeShortcut): Boolean =
    if (Build.VERSION.SDK_INT < 26) false
    else logged { ShortcutManagerCompat.updateShortcuts(context, listOf(info(shortcut))) }

  private fun info(shortcut: PrototypeShortcut): ShortcutInfoCompat =
    ShortcutInfoCompat.Builder(context, shortcut.id)
      .setShortLabel(shortcut.shortLabel)
      .setLongLabel(shortcut.longLabel)
      .setIntent(intents.intentFor(shortcut.id))
      .setIcon(
        IconCompat.createWithAdaptiveBitmap(
          icons.render(shortcut.iconBytes, shortcut.longLabel),
        ),
      )
      .build()

  private inline fun <T> logged(action: () -> T): T =
    try {
      action()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PinnedPrototypeShortcuts", "Launcher shortcut operation failed", error)
      throw error
    }
}
