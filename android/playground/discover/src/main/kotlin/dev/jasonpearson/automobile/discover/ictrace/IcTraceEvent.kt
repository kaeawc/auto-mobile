package dev.jasonpearson.automobile.discover.ictrace

data class IcTraceEvent(
  val seq: Int,
  val elapsedMs: Long,
  val call: String,
  val args: String,
  val selectionStart: Int,
  val selectionEnd: Int,
  val composingStart: Int,
  val composingEnd: Int,
  val result: Boolean? = null,
  val readValue: String? = null,
  val droppedEvents: Int = 0,
  val metadata: IcTraceMetadata = IcTraceMetadata(),
)

data class IcTraceMetadata(
  val scenario: String = "unspecified",
  val keyboardId: String? = null,
  val keyboardVersion: String? = null,
  val editorPackage: String? = null,
  val editorFieldId: Int = 0,
  val editorFieldName: String? = null,
  val inputType: Int = 0,
  val imeOptions: Int = 0,
  val privateImeOptions: String? = null,
)
