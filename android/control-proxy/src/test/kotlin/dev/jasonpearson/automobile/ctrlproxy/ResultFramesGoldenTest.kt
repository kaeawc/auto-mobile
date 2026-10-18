package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the typed result frames (#11877) to the bytes the hand-built frames wrote. The `legacy*`
 * functions below are the previous builders, kept verbatim as the oracle; each test runs both and
 * compares the full frame text (the clock is the only difference, so it is masked).
 */
class ResultFramesGoldenTest {
  private val json = Json {
    prettyPrint = false
    encodeDefaults = true
  }

  private fun legacyFrame(
    type: String,
    requestId: String?,
    perfTiming: JsonElement? = null,
    content: JsonObjectBuilder.() -> Unit,
  ): String =
    json.encodeToString(
      buildJsonObject {
        put("type", type)
        put("timestamp", 0L)
        if (requestId != null) put("requestId", requestId)
        content()
        if (perfTiming != null) put("perfTiming", perfTiming)
      },
    )

  private fun legacyGesture(
    type: String,
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
    perfTiming: JsonElement?,
  ) =
    legacyFrame(type, requestId, perfTiming) {
      put("success", success)
      put("totalTimeMs", totalTimeMs)
      if (gestureTimeMs != null) put("gestureTimeMs", gestureTimeMs)
      if (error != null) put("error", error)
    }

  private fun masked(frame: String) = frame.replace(Regex("\"timestamp\":\\d+"), "\"timestamp\":0")

  private val perf = Json.parseToJsonElement("""{"total":50,"steps":[1,2]}""")
  private val errors = listOf(null, "boom \"q\" \n é")
  private val requestIds = listOf(null, "req-1")
  private val perfs = listOf(null, perf)
  private val gestureTimes = listOf(null, 5L)

  @Test
  fun `swipe drag and pinch frames match the hand-built bytes`() {
    val builders =
      listOf(
        Triple("swipe_result", ::swipeResultFrame, 0),
        Triple("drag_result", ::dragResultFrame, 0),
        Triple("pinch_result", ::pinchResultFrame, 0),
      )
    for ((type, build, _) in builders) for (id in requestIds) for (err in errors) for (g in
      gestureTimes) for (p in perfs) {
      assertEquals(
        "$type id=$id err=$err g=$g perf=$p",
        legacyGesture(type, id, err == null, err, 10L, g, p),
        masked(build(id, err == null, err, 10L, g, p)),
      )
    }
  }

  @Test
  fun `tap coordinates frame matches the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (p in perfs) {
      val legacy =
        legacyFrame("tap_coordinates_result", id, p) {
          put("success", err == null)
          put("totalTimeMs", 10L)
          if (err != null) put("error", err)
        }
      assertEquals(legacy, masked(tapCoordinatesResultFrame(id, err == null, err, 10L, p)))
    }
  }

  @Test
  fun `current focus and traversal order error frames match the hand-built bytes`() {
    for (id in requestIds) for (err in errors) {
      assertEquals(
        legacyFrame("current_focus_result", id) {
          put("totalTimeMs", 10L)
          put("error", err ?: "Unknown error")
        },
        masked(currentFocusErrorFrame(id, err, 10L)),
      )
      assertEquals(
        legacyFrame("traversal_order_result", id) {
          put("totalTimeMs", 10L)
          put("error", err ?: "Unknown error")
        },
        masked(traversalOrderErrorFrame(id, err, 10L)),
      )
    }
  }

  @Test
  fun `insert text body matches the hand-built content in every optional combination`() {
    for (err in errors) for (warning in listOf(null, "w")) for (caret in
      listOf(null, true, false)) {
      for (len in listOf(null, 7)) for (partial in listOf(false, true)) {
        for (p in perfs) {
          val legacy =
            legacyFrame("insert_text_result", "r", p) {
              put("success", err == null)
              put("totalTimeMs", 3L)
              if (err != null) put("error", err)
              if (warning != null) put("warning", warning)
              if (caret != null) put("caretPlaced", caret)
              if (len != null) put("resultingTextLength", len)
              if (partial) put("partialApplication", true)
            }
          val typed =
            legacyFrame("insert_text_result", "r", p) {
              InsertTextResultBody(
                  success = err == null,
                  totalTimeMs = 3L,
                  error = err,
                  warning = warning,
                  caretPlaced = caret,
                  resultingTextLength = len,
                  partialApplication = partial,
                )
                .putInto(this)
            }
          assertEquals(legacy, typed)
        }
      }
    }
  }

  @Test
  fun `clipboard and ca cert frames match the hand-built bytes`() {
    val texts = listOf(null, "clip \"q\" é")
    for (id in requestIds) for (err in errors) for (text in texts) for (p in perfs) {
      assertEquals(
        legacyFrame("clipboard_result", id, p) {
          put("action", "get")
          put("success", err == null)
          put("totalTimeMs", 10L)
          if (text != null) put("text", text)
          if (err != null) put("error", err)
        },
        masked(clipboardResultFrame(id, "get", err == null, text, err, 10L, p)),
      )
      assertEquals(
        legacyFrame("ca_cert_result", id, p) {
          put("action", "install")
          put("success", err == null)
          put("totalTimeMs", 10L)
          if (text != null) put("alias", text)
          if (err != null) put("error", err)
        },
        masked(caCertResultFrame(id, "install", err == null, text, err, 10L, p)),
      )
    }
  }

  @Test
  fun `device owner status frame matches the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (p in perfs) for (owner in listOf(false, true)) {
      assertEquals(
        legacyFrame("device_owner_status_result", id, p) {
          put("success", err == null)
          put("totalTimeMs", 10L)
          put("packageName", "dev.example")
          put("isDeviceOwner", owner)
          put("isAdminActive", !owner)
          if (err != null) put("error", err)
        },
        masked(deviceOwnerStatusResultFrame(id, "dev.example", owner, !owner, err, 10L, p)),
      )
    }
  }

  @Test
  fun `ime action and select all frames match the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (p in perfs) {
      for (approximated in listOf(null, false, true)) {
        assertEquals(
          legacyFrame("ime_action_result", id, p) {
            if (approximated != null) put("approximated", approximated)
            put("action", "next")
            put("success", err == null)
            put("totalTimeMs", 10L)
            if (err != null) put("error", err)
          },
          masked(imeActionResultFrame(id, "next", err == null, err, 10L, approximated, p)),
        )
      }
      assertEquals(
        legacyFrame("select_all_result", id, p) {
          put("success", err == null)
          put("totalTimeMs", 10L)
          if (err != null) put("error", err)
        },
        masked(selectAllResultFrame(id, err == null, err, 10L, p)),
      )
    }
  }
}
