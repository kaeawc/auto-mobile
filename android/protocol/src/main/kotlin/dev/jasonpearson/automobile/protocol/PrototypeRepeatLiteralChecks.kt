package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.chargeText
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.dataTextError
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.fail
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.string
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.RepeatState
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.stateKeyPattern
import kotlinx.serialization.json.JsonObject

internal object PrototypeRepeatLiteralChecks {
  /** Outside every template a state key is literal, so a placeholder there is an invalid key. */
  fun checkLiteralKeys(
    node: JsonObject,
    path: String,
    state: RepeatState,
  ): PrototypeSpecError? =
    PrototypeBindableFields.first(node, path) { value, fieldPath, kind ->
      val text = value.string()
      val binding = value as? JsonObject
      if (kind == PrototypeBindableKind.EMIT_BINDING && hasItemOrIndex(binding))
        fail(fieldPath, "Emit item/index binding outside a repeat template")
      else if (isOversizedDataText(kind, text, state)) dataTextError(fieldPath, state)
      else literalPlaceholderError(kind, text, fieldPath)
    }

  fun literalPlaceholderError(
    kind: PrototypeBindableKind,
    text: String?,
    fieldPath: String,
  ): PrototypeSpecError? =
    if (
      kind == PrototypeBindableKind.KEY &&
        text != null &&
        !stateKeyPattern.matches(
          PrototypeRepeatTemplate.segments(text, "route").joinToString("") {
            if (it is PrototypeRepeatSegment.Literal) it.text else "r"
          },
        )
    )
      fail(fieldPath, "State key placeholder outside a repeat template")
    else if (kind.isDataPath() && text != null && PrototypeRepeatTemplate.dataPathHasIndex(text))
      fail(fieldPath, "{index} outside a repeat template")
    else null

  fun hasItemOrIndex(binding: JsonObject?): Boolean =
    binding != null && ("item" in binding || "index" in binding)

  fun isOversizedDataText(kind: PrototypeBindableKind, text: String?, state: RepeatState): Boolean {
    val isText = kind == PrototypeBindableKind.TEXT || kind == PrototypeBindableKind.REQUEST_TEXT
    return isText && text != null && state.data.text(text) { chargeText(state, it) } == null
  }
}
