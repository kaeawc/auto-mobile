package dev.jasonpearson.automobile.prototype

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.*

const val MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES = 65536

/** Clipboard I/O is injectable; a refused read throws SecurityException. */
interface PrototypeClipboard {
  fun copy(text: String, sensitive: Boolean, label: String?)

  suspend fun paste(): String

  suspend fun hasText(): Boolean
}

class FakePrototypeClipboard(var text: String = "", var denied: Boolean = false) :
  PrototypeClipboard {
  private val audit = mutableListOf<JsonObject>()
  val platformCalls: List<JsonObject>
    get() = audit.toList()

  private fun record(op: String, bytes: Int = 0) {
    audit.add(
      buildJsonObject {
        put("op", op)
        put("bytes", bytes)
      },
    )
  }

  var sensitive: Boolean = false
    private set

  var label: String? = null
    private set

  override fun copy(text: String, sensitive: Boolean, label: String?) {
    record("copy", text.toByteArray(Charsets.UTF_8).size)
    this.text = text
    this.sensitive = sensitive
    this.label = label
  }

  override suspend fun paste(): String {
    record("paste", if (denied) 0 else text.toByteArray(Charsets.UTF_8).size)
    if (denied) throw SecurityException("Clipboard permission denied")
    return text
  }

  override suspend fun hasText(): Boolean {
    record("hasText")
    return text.isNotEmpty()
  }
}

/** Runs clipboard queries while the host owns input focus, without reading clipboard text. */
interface PrototypeClipboardFocus {
  suspend fun <T> read(block: () -> T): T
}

/** The overlay supplies a focus wrapper; foreground apps use the ordinary manager read. */
class AndroidPrototypeClipboard(
  context: Context,
  private val focus: PrototypeClipboardFocus? = null,
) : PrototypeClipboard {
  private val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  override fun copy(text: String, sensitive: Boolean, label: String?) {
    val clip = ClipData.newPlainText(label ?: "AutoMobile", text)
    if (sensitive && Build.VERSION.SDK_INT >= 33) {
      clip.description.extras =
        PersistableBundle().apply {
          putBoolean("android.content.extra.IS_SENSITIVE", true)
        }
    }
    manager.setPrimaryClip(clip)
  }

  override suspend fun paste(): String {
    // A null primary clip is reported as empty: a focused foreground app cannot tell "empty" from
    // "read refused", and the issue requires an empty clipboard to succeed with text "".
    val get = {
      manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() ?: ""
    }
    return focus?.read(get) ?: get()
  }

  override suspend fun hasText(): Boolean {
    // "A text clip exists" (mime type), without reading the text; a clip of "" still counts.
    val query = { manager.primaryClipDescription?.hasMimeType("text/*") == true }
    return focus?.read(query) ?: query()
  }
}

class PrototypeClipboardModule(private val clipboard: PrototypeClipboard) :
  PrototypePlatformModule {
  override val name = "clipboard"
  override val capability = "prototype_platform_clipboard_v1"
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() = PlatformAvailability.Ready

  override fun close() = Unit

  override suspend fun call(call: PlatformCall): PlatformCallResult =
    try {
      when (call.call) {
        "clipboard.copy" -> copy(call.args)
        "clipboard.paste" -> PlatformCallResult.Success(pasteValue(clipboard.paste()))
        "clipboard.hasText" -> PlatformCallResult.Success(JsonPrimitive(clipboard.hasText()))
        else ->
          PlatformCallResult.Failure(
            PlatformError(PlatformErrorCode.UNSUPPORTED, "Unknown clipboard call"),
          )
      }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: SecurityException) {
      PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.PERMISSION_DENIED, "Clipboard permission denied"),
      )
    } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
      // Platform exceptions may contain clipboard content; never forward their messages.
      PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.PLATFORM_ERROR, "Clipboard operation failed"),
      )
    }

  private fun copy(args: JsonObject): PlatformCallResult {
    val text =
      (args["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: return PlatformCallResult.Failure(
          PlatformError(PlatformErrorCode.INVALID_ARGS, "text is required"),
        )
    val bytes = text.toByteArray(Charsets.UTF_8).size
    if (bytes > MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES) {
      return PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.INVALID_ARGS, "Clipboard text exceeds byte limit"),
      )
    }
    clipboard.copy(
      text,
      (args["sensitive"] as? JsonPrimitive)?.booleanOrNull ?: false,
      (args["label"] as? JsonPrimitive)?.contentOrNull,
    )
    return PlatformCallResult.Success(
      buildJsonObject {
        put("op", "copy")
        put("bytes", bytes)
      },
    )
  }

  private fun pasteValue(text: String): JsonObject {
    val bytes = text.toByteArray(Charsets.UTF_8)
    var end = minOf(bytes.size, MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES)
    while (end < bytes.size && end > 0 && (bytes[end].toInt() and 0xc0) == 0x80) end--
    return buildJsonObject {
      put("text", String(bytes, 0, end, Charsets.UTF_8))
      put("truncated", end < bytes.size)
    }
  }
}
