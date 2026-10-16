package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType

/** `imeAction` to Compose; absent keeps the platform default, `onSubmit` alone means done. */
internal fun prototypeTextFieldImeAction(action: String?, hasSubmit: Boolean): ImeAction =
  when (action) {
    "done" -> ImeAction.Done
    "next" -> ImeAction.Next
    "search" -> ImeAction.Search
    "send" -> ImeAction.Send
    "go" -> ImeAction.Go
    else -> if (hasSubmit) ImeAction.Done else ImeAction.Default
  }

internal fun prototypeTextFieldSecure(secure: Boolean?, keyboardType: String?): Boolean =
  secure == true || keyboardType == "password"

internal fun prototypeTextFieldKeyboardType(type: String?, secure: Boolean?): KeyboardType =
  when (type) {
    "password" -> KeyboardType.Password
    "number" -> if (secure == true) KeyboardType.NumberPassword else KeyboardType.Number
    "decimal" -> KeyboardType.Decimal
    "email" -> KeyboardType.Email
    "phone" -> KeyboardType.Phone
    "url" -> KeyboardType.Uri
    else -> if (secure == true) KeyboardType.Password else KeyboardType.Text
  }

/** Limits UTF-16 code units without cutting an intact surrogate pair in half. */
internal fun prototypeTextFieldClip(value: String, maxLength: Int?): String {
  if (maxLength == null || value.length <= maxLength) return value
  val clipped = value.take(maxLength)
  return if (clipped.lastOrNull()?.isHighSurrogate() == true && value[maxLength].isLowSurrogate())
    clipped.dropLast(1)
  else clipped
}

internal fun prototypeTextFieldCounter(value: String, maxLength: Int?): String? = maxLength?.let {
  "${value.length}/$it"
}

/**
 * The field's trailing icon: a button with the authored label when it has `onTap`, else decoration.
 */
@androidx.compose.runtime.Composable
internal fun PrototypeTextFieldTrailingIcon(
  node: PrototypeRenderNode,
  action: dev.jasonpearson.automobile.protocol.PrototypeAppBarAction,
  interact: (PrototypeInteraction) -> Unit,
) {
  val icon = prototypeIcon(action.icon) ?: return
  val tag = node.testTag?.let { "$it.trailingIcon" }
  val taps = action.onTap.orEmpty()
  if (taps.isEmpty()) {
    androidx.compose.material3.Icon(icon, contentDescription = null)
  } else {
    androidx.compose.material3.IconButton(
      onClick = { interact(PrototypeInteraction.Tap(taps)) },
      modifier =
        androidx.compose.ui.Modifier.semantics {
          contentDescription = action.label
          tag?.let { testTag = it }
        },
    ) {
      androidx.compose.material3.Icon(icon, contentDescription = null)
    }
  }
}
