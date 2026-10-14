package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.CancellationException

class PrototypeShortcut(
  val id: String,
  val shortLabel: String,
  val longLabel: String,
  val iconBytes: ByteArray?,
)

interface PinnedShortcutPlatform {
  fun isRequestPinSupported(): Boolean

  fun pinnedIds(): Set<String>

  fun enable(shortcut: PrototypeShortcut)

  /** True when the launcher dialog was raised; may throw when backgrounded or locked. */
  fun requestPin(shortcut: PrototypeShortcut): Boolean

  /** False when rate limited. Null icon bytes preserve the pinned shortcut's existing icon. */
  fun update(shortcut: PrototypeShortcut): Boolean
}

enum class ShortcutUpdate {
  UPDATED,
  RATE_LIMITED,
}

sealed interface PinOutcome {
  data object Requested : PinOutcome

  data class AlreadyPinned(val update: ShortcutUpdate) : PinOutcome

  data class Unsupported(val message: String) : PinOutcome

  data class DeviceLocked(val message: String) : PinOutcome

  data class Failed(val message: String) : PinOutcome
}

interface PrototypeShortcutPinner {
  fun pin(id: String, label: String, iconBytes: ByteArray?): PinOutcome

  /** Null if not pinned or a best-effort update failed. */
  fun updateIfPinned(id: String, label: String, iconBytes: ByteArray?): ShortcutUpdate?
}

object UnsupportedShortcutPinner : PrototypeShortcutPinner {
  override fun pin(id: String, label: String, iconBytes: ByteArray?) =
    PinOutcome.Unsupported(
      "The default launcher does not support pinned shortcuts (check `adb shell cmd shortcut get-default-launcher` on the host)",
    )

  override fun updateIfPinned(id: String, label: String, iconBytes: ByteArray?): ShortcutUpdate? =
    null
}

class PinnedPrototypeShortcuts(private val platform: PinnedShortcutPlatform) :
  PrototypeShortcutPinner {
  override fun pin(id: String, label: String, iconBytes: ByteArray?): PinOutcome =
    try {
      if (!platform.isRequestPinSupported()) {
        UnsupportedShortcutPinner.pin(id, label, iconBytes)
      } else {
        val shortcut = shortcut(id, label, iconBytes)
        if (shortcut.id in platform.pinnedIds()) {
          platform.enable(shortcut)
          PinOutcome.AlreadyPinned(update(shortcut))
        } else {
          try {
            if (platform.requestPin(shortcut)) PinOutcome.Requested
            else PinOutcome.Failed("Launcher refused the pin request")
          } catch (error: CancellationException) {
            throw error
          } catch (error: IllegalStateException) {
            PinOutcome.DeviceLocked(
              "Wake and unlock the device, keep CtrlProxy in the foreground, and retry",
            )
          }
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      PinOutcome.Failed(error.message ?: error.javaClass.simpleName)
    }

  override fun updateIfPinned(id: String, label: String, iconBytes: ByteArray?): ShortcutUpdate? =
    try {
      val shortcut = shortcut(id, label, iconBytes)
      if (shortcut.id in platform.pinnedIds()) {
        platform.enable(shortcut)
        update(shortcut)
      } else null
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      // The Android platform logs failures; saved content remains authoritative.
      null
    }

  private fun update(shortcut: PrototypeShortcut) =
    if (platform.update(shortcut)) ShortcutUpdate.UPDATED else ShortcutUpdate.RATE_LIMITED

  private fun shortcut(id: String, label: String, iconBytes: ByteArray?) =
    PrototypeShortcut(
      shortcutIdFor(id),
      shortLabelFor(label, id),
      longLabelFor(label, id),
      iconBytes,
    )
}

internal fun shortLabelFor(label: String, fallback: String): String =
  boundedLabel(label.trim().ifBlank { fallback }, 10)

internal fun longLabelFor(label: String, fallback: String): String =
  boundedLabel(label.trim().ifBlank { fallback }, 25)

private fun boundedLabel(label: String, limit: Int): String {
  var end = minOf(label.length, limit)
  if (
    end < label.length &&
      Character.isHighSurrogate(label[end - 1]) &&
      Character.isLowSurrogate(label[end])
  )
    end--
  return label.substring(0, end)
}
