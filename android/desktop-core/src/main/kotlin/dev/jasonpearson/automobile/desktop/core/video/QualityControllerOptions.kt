package dev.jasonpearson.automobile.desktop.core.video

data class QualityControllerOptions(
  val initialQuality: VideoStreamQuality,
  val targetFps: Int,
  val autoAdjustEnabled: Boolean = true,
  val rateWindowMs: Long = 2_000,
  val minSamplesForDecision: Int = 5,
  val idleIntervalMs: Long = 90,
  val downgradeRatio: Double = 0.8,
  val upgradeRatio: Double = 0.95,
  val samplesToDowngrade: Int = 3,
  val samplesToUpgrade: Int = 8,
  val minDwellMs: Long = 2_000,
  val onManualSelection: (VideoStreamQuality) -> Unit = {},
)
