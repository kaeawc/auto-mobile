@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import org.jetbrains.skia.Image

@Composable
internal fun DeviceScreenOptions.rememberDeviceScreenBitmap(
  screenshotData: ByteArray?,
  liveFrame: ImageBitmap?,
): ImageBitmap? {
  val decodedScreenshot =
    remember(screenshotData) {
      screenshotData?.let {
        try {
          Image.makeFromEncoded(it).toComposeImageBitmap()
        } catch (e: IllegalArgumentException) {
          DEVICE_SCREEN_LOG.warn("Could not decode screenshot: ${e.message}", e)
          null
        }
      }
    }
  val rawBitmap = liveFrame ?: decodedScreenshot

  // Detect rotation needed to align the screenshot with the hierarchy coordinate system.
  // iOS screenshots arrive in native pixel orientation (portrait) even when the device
  // is landscape, while hierarchy bounds are in display orientation — so we must rotate
  // the screenshot to match. Some Android screenshots may also need rotation.
  // We auto-detect by comparing screenshot image dimensions to the hierarchy coordinate
  // space dimensions (root bounds, or screenWidth/screenHeight as fallback when the
  // root node has no explicit bounds — common for Android accessibility service).
  val screenshotRotation =
    remember(rawBitmap, hierarchy, screenWidth, screenHeight) {
      val imgW = rawBitmap?.width ?: 0
      val imgH = rawBitmap?.height ?: 0
      // Prefer root bounds; fall back to screenWidth/screenHeight when root has no bounds
      // (Android accessibility service root nodes typically have (0,0,0,0)).
      val rootW = hierarchy?.bounds?.width?.takeIf { it > 0 } ?: screenWidth
      val rootH = hierarchy?.bounds?.height?.takeIf { it > 0 } ?: screenHeight
      // Compose-free rotation detection lives in DeviceScreenCoordinateMapper so daemon clients
      // (and the coordinate-mapping tests) share exactly this rule.
      DeviceScreenCoordinateMapper.detectScreenshotRotation(imgW, imgH, rootW, rootH)
    }

  // Rotate the raw bitmap to align with the hierarchy coordinate system.
  // After this, overlays and hit testing use direct coordinate mapping.
  val imageBitmap =
    remember(rawBitmap, screenshotRotation) {
      val original = rawBitmap ?: return@remember null
      rotateDeviceBitmap(original, screenshotRotation)
    }

  return imageBitmap
}

internal fun rotateDeviceBitmap(original: ImageBitmap, screenshotRotation: Int): ImageBitmap {
  if (screenshotRotation == 0) return original

  val angleDegrees =
    when (screenshotRotation) {
      1 -> 270f
      2 -> 180f
      3 -> 90f
      else -> return original
    }

  return try {
    val w = original.width
    val h = original.height
    val swapDims = screenshotRotation == 1 || screenshotRotation == 3
    val newW = if (swapDims) h else w
    val newH = if (swapDims) w else h

    // Reuse the bitmap decoded above rather than decoding the bytes a second time. This is
    // also what makes rotation work for live frames, which have no encoded bytes at all.
    val skiaImage = Image.makeFromBitmap(original.asSkiaBitmap())
    val surface = org.jetbrains.skia.Surface.makeRasterN32Premul(newW, newH)
    val canvas = surface.canvas
    canvas.translate(newW / 2f, newH / 2f)
    canvas.rotate(angleDegrees)
    canvas.translate(-w / 2f, -h / 2f)
    canvas.drawImage(skiaImage, 0f, 0f)
    surface.makeImageSnapshot().toComposeImageBitmap()
  } catch (e: IllegalArgumentException) {
    DEVICE_SCREEN_LOG.warn("Could not rotate screenshot: ${e.message}", e)
    original
  }
}
