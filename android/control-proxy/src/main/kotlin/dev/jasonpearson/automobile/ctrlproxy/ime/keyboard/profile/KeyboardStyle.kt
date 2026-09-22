package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

data class KeyboardStyle(
  val keyHeightPortraitDp: Float,
  val keyHeightLandscapeDp: Float,
  val keyGapDp: Float,
  val keyCornerRadiusDp: Float,
  val backgroundArgb: Long,
  val keyArgb: Long,
  val specialKeyArgb: Long,
  val keyPressedArgb: Long,
  val labelArgb: Long,
  val accentArgb: Long,
)
