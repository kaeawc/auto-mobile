package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionElement
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionEvent
import dev.jasonpearson.automobile.protocol.InsertTextState
import dev.jasonpearson.automobile.protocol.KeyboardProfileBehaviorInfo
import dev.jasonpearson.automobile.protocol.KeyboardProfileInfo
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
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

  private data class GestureTiming(
    val totalTimeMs: Long,
    val gestureTimeMs: Long?,
    val perfTiming: JsonElement?,
  )

  private fun legacyGesture(
    type: String,
    requestId: String?,
    success: Boolean,
    error: String?,
    timing: GestureTiming,
  ) =
    legacyFrame(type, requestId, timing.perfTiming) {
      put("success", success)
      put("totalTimeMs", timing.totalTimeMs)
      if (timing.gestureTimeMs != null) put("gestureTimeMs", timing.gestureTimeMs)
      if (error != null) put("error", error)
    }

  private fun masked(frame: String) = frame.replace(Regex("\"timestamp\":\\d+"), "\"timestamp\":0")

  private val perf = Json.parseToJsonElement("""{"total":50,"steps":[1,2]}""")
  private val errors = listOf(null, "boom \"q\" \n é")
  private val requestIds = listOf(null, "req-1")
  private val perfs = listOf(null, perf)
  private val gestureTimes = listOf(null, 5L)

  private val frameContexts = requestIds.flatMap { id ->
    errors.flatMap { err -> perfs.map { p -> Triple(id, err, p) } }
  }

  @Test
  fun `swipe drag and pinch frames match the hand-built bytes`() {
    val builders =
      listOf(
        Triple("swipe_result", ::swipeResultFrame, 0),
        Triple("drag_result", ::dragResultFrame, 0),
        Triple("pinch_result", ::pinchResultFrame, 0),
      )
    val requests = requestIds.flatMap { id -> errors.map { err -> id to err } }
    for ((type, build, _) in builders) for ((id, err) in requests) for (g in gestureTimes) for (p in
      perfs) {
      assertEquals(
        "$type id=$id err=$err g=$g perf=$p",
        legacyGesture(
          type,
          id,
          err == null,
          err,
          timing = GestureTiming(totalTimeMs = 10L, gestureTimeMs = g, perfTiming = p),
        ),
        masked(build(GestureFrameResult(id, err == null, err, 10L, g), p)),
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
  fun `insert text frame matches the hand-built content in every optional combination`() {
    val outcomes = errors.flatMap { err ->
      listOf(null, "w").flatMap { warning ->
        listOf(null, true, false).map { caret -> Triple(err, warning, caret) }
      }
    }
    val applications =
      listOf(null, 7).flatMap { len ->
        listOf(false, true).flatMap { partial -> perfs.map { p -> Triple(len, partial, p) } }
      }
    for ((err, warning, caret) in outcomes) {
      for ((len, partial, p) in applications) {
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
        assertEquals(
          legacy,
          masked(
            insertTextResultFrame(
              InsertTextFrameResult(
                requestId = "r",
                success = err == null,
                error = err,
                totalTimeMs = 3L,
                warning = warning,
                caretPlaced = caret,
                resultingTextLength = len,
                partialApplication = partial,
              ),
              p,
            ),
          ),
        )
      }
    }
  }

  @Test
  fun `set text and insert text state frames match the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (p in perfs) {
      assertEquals(
        legacyFrame("set_text_result", id, p) {
          put("success", err == null)
          put("totalTimeMs", 3L)
          if (err != null) put("error", err)
        },
        masked(setTextResultFrame(id, err == null, err, 3L, p)),
      )
      for (state in
        listOf(
          null,
          InsertTextState("abc \"q\"", true, 1, 2),
          InsertTextState(null, false, -1, -1),
        )) {
        assertEquals(
          legacyFrame("insert_text_state_result", id, p) {
            put("success", true)
            if (state != null) put("state", json.encodeToJsonElement(state))
          },
          masked(insertTextStateResultFrame(id, state, p)),
        )
      }
    }
  }

  @Test
  fun `commit text and cancel ime commit frames match the hand-built bytes`() {
    val traces = listOf(null, listOf("a", "b \"q\""), emptyList())
    val edits =
      listOf(false, true).flatMap { partial ->
        listOf(0, 4).flatMap { units ->
          listOf(null, "tx é").map { inserted -> Triple(partial, units, inserted) }
        }
      }
    for (context in frameContexts) for (edit in edits) {
      val (id, _, p) = context
      val (partial, units, _) = edit
      for (trace in traces) for (consumed in listOf(false, true)) {
        assertCommitFrame(context, edit, trace, consumed)
      }
      assertCancelFrame(id, p, partial, units)
    }
  }

  private fun assertCancelFrame(id: String?, p: JsonElement?, partial: Boolean, units: Int) {
    assertEquals(
      legacyFrame("cancel_ime_commit_result", id, p) {
        put("success", true)
        put("targetRequestId", "target")
        put("partialApplication", partial)
        if (units > 0) put("committedUnits", units)
      },
      masked(cancelImeCommitResultFrame(id, "target", partial, units, p)),
    )
  }

  private fun assertCommitFrame(
    context: Triple<String?, String?, JsonElement?>,
    edit: Triple<Boolean, Int, String?>,
    trace: List<String>?,
    consumed: Boolean,
  ) {
    val (id, err, p) = context
    val (partial, units, inserted) = edit
    assertEquals(
      legacyFrame("commit_text_result", id, p) {
        put("success", err == null)
        put("totalTimeMs", 9L)
        if (partial) put("partialApplication", true)
        if (units > 0) put("committedUnits", units)
        if (inserted != null) put("insertedText", inserted)
        if (consumed) put("editorConsumed", true)
        if (trace != null) put("trace", json.encodeToJsonElement(trace))
        if (err != null) put("error", err)
      },
      masked(
        commitTextResultFrame(
          CommitTextFrameResult(
            requestId = id,
            success = err == null,
            error = err,
            totalTimeMs = 9L,
            partialApplication = partial,
            committedUnits = units,
            insertedText = inserted,
            trace = trace,
            editorConsumed = consumed,
          ),
          p,
        ),
      ),
    )
  }

  @Test
  fun `keyboard profiles frame matches the hand-built bytes`() {
    val profiles =
      listOf(
        KeyboardProfileInfo(
          id = "gboard",
          displayName = "Gboard \"x\"",
          version = 1,
          evidenceStatus = "verified",
          evidenceNote = "note",
          behavior =
            KeyboardProfileBehaviorInfo(true, "KEY_EVENT", "KEY_EVENT", false, true, false),
        ),
      )
    for ((id, err, p) in frameContexts) for (version in listOf(null, 1)) {
      for (active in listOf(null, "gboard")) {
        val success = err == null
        assertEquals(
          legacyFrame("keyboard_profiles_result", id, p) {
            put("success", success)
            put("catalogId", "automobile_behavior_profiles")
            if (version != null) put("catalogVersion", version)
            put("supportedCatalogVersions", json.encodeToJsonElement(listOf(1)))
            if (active != null) put("activeProfileId", active)
            if (success) put("profiles", json.encodeToJsonElement(profiles))
            if (err != null) put("error", err)
          },
          masked(
            keyboardProfilesResultFrame(
              KeyboardProfilesResult(
                requestId = id,
                success = success,
                catalogVersion = version,
                supportedCatalogVersions = listOf(1),
                activeProfileId = active,
                profiles = profiles,
                error = err,
              ),
              p,
            ),
          ),
        )
      }
    }
  }

  @Test
  fun `screenshot error and display transition frames match the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (display in listOf(null, 2)) for (panel in
      listOf(null, "panel-1")) {
      assertEquals(
        legacyFrame("screenshot_error", id) {
          put("error", err ?: "x")
          if (display != null) put("displayId", display)
          if (panel != null) put("panelUniqueId", panel)
        },
        masked(screenshotErrorFrame(id, err ?: "x", display, panel)),
      )
    }
    val fingerprints = listOf(null, PanelFingerprint(1080, 2400))
    for (panel in listOf(null, "p")) for (fp in fingerprints) for (n in listOf<Int?>(null, 3)) {
      val t = DisplayTransition("rotation", 1, panel, n, n?.plus(1), n, n?.plus(2), n?.plus(3), fp)
      assertDisplayTransitionFrame(t)
    }
  }

  private fun assertDisplayTransitionFrame(t: DisplayTransition) {
    assertEquals(
      legacyFrame("display_transition", null) {
        put("change", t.change)
        put("displayId", t.displayId)
        if (t.panelUniqueId != null) put("panelUniqueId", t.panelUniqueId)
        t.panelFingerprint?.let { f ->
          put(
            "panelFingerprint",
            buildJsonObject {
              put("width", f.width)
              put("height", f.height)
            },
          )
        }
        if (t.width != null) put("width", t.width)
        if (t.height != null) put("height", t.height)
        if (t.state != null) put("state", t.state)
        if (t.rotation != null) put("rotation", t.rotation)
        if (t.deviceState != null) put("deviceState", t.deviceState)
      },
      masked(displayTransitionFrame(t)),
    )
  }

  @Test
  fun `interaction and package event frames match the hand-built bytes`() {
    val interactions =
      listOf(
        InteractionEvent(type = "tap", timestamp = 5L),
        InteractionEvent(
          type = "scroll",
          timestamp = 6L,
          packageName = "p",
          element = InteractionElement(text = "t \"q\"", bounds = ElementBounds(1, 2, 3, 4)),
          scrollDeltaY = -9,
        ),
      )
    for (interaction in interactions) {
      assertEquals(
        json.encodeToString(
          buildJsonObject {
            put("type", "interaction_event")
            put("timestamp", interaction.timestamp)
            put("event", json.encodeToJsonElement(interaction))
          },
        ),
        interactionEventFrame(interaction.timestamp, json.encodeToString(interaction)),
      )
    }
    for (uid in listOf<Int?>(null, 1010234)) for (system in listOf<Boolean?>(null, true)) {
      for (removed in listOf(false, true)) {
        assertEquals(
          json.encodeToString(
            buildJsonObject {
              put("type", "package_event")
              put("timestamp", 7L)
              put(
                "event",
                buildJsonObject {
                  put("action", "added")
                  put("packageName", "com.example")
                  put("userId", 10)
                  if (uid != null) put("uid", uid)
                  if (system != null) put("isSystem", system)
                  if (removed) put("removedForAllUsers", true)
                },
              )
            },
          ),
          packageEventFrame(
            PackageEventResult(
              timestamp = 7L,
              action = "added",
              packageName = "com.example",
              userId = 10,
              uid = uid,
              isSystem = system,
              removedForAllUsers = removed,
            ),
          ),
        )
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
        masked(
          clipboardResultFrame(
            ClipboardFrameResult(
              requestId = id,
              action = "get",
              success = err == null,
              text = text,
              error = err,
              totalTimeMs = 10L,
            ),
            p,
          ),
        ),
      )
      assertEquals(
        legacyFrame("ca_cert_result", id, p) {
          put("action", "install")
          put("success", err == null)
          put("totalTimeMs", 10L)
          if (text != null) put("alias", text)
          if (err != null) put("error", err)
        },
        masked(
          caCertResultFrame(
            CaCertificateResult(
              requestId = id,
              action = "install",
              success = err == null,
              alias = text,
              error = err,
              totalTimeMs = 10L,
            ),
            p,
          ),
        ),
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
        masked(
          deviceOwnerStatusResultFrame(
            DeviceOwnerResult(
              requestId = id,
              packageName = "dev.example",
              isDeviceOwner = owner,
              isAdminActive = !owner,
              error = err,
              totalTimeMs = 10L,
            ),
            p,
          ),
        ),
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
          masked(
            imeActionResultFrame(
              ImeActionFrameResult(
                requestId = id,
                action = "next",
                success = err == null,
                error = err,
                totalTimeMs = 10L,
                approximated = approximated,
              ),
              p,
            ),
          ),
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
