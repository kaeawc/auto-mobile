package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.text.input.KeyboardType

internal fun prototypeTextFieldSecure(secure: Boolean?, keyboardType: String?): Boolean =
  secure == true || keyboardType == "password"

internal fun prototypeTextFieldKeyboardType(type: String?, secure: Boolean?): KeyboardType =
  if (prototypeTextFieldSecure(secure, type)) KeyboardType.Password
  else
    when (type) {
      "number" -> KeyboardType.Number
      "decimal" -> KeyboardType.Decimal
      "email" -> KeyboardType.Email
      "phone" -> KeyboardType.Phone
      "url" -> KeyboardType.Uri
      else -> KeyboardType.Text
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
