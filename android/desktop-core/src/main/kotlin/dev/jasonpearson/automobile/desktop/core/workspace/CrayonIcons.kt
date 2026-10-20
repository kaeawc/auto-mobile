package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

/**
 * The app's hand-drawn crayon/marker icon set — outline only, no fill. Every glyph is authored as a
 * [Canvas] vector drawing (no raster assets) from gently *bowed* strokes (a line pushed off its
 * midpoint) with round caps, so shapes read as marker-drawn rather than geometric. Bow directions
 * are fixed, so a glyph looks identical frame to frame. Replaces the emoji glyphs across the
 * workspace; [CrayonIcon] renders one at any size/tint.
 */
enum class CrayonGlyph {
  Back,
  Home,
  Recent,
  Power,
  PointerTap, // Input mode
  Inspect, // magnifier
  Rotate,
  Camera, // screenshot
  Layers, // snapshot
  Globe, // locale / network
  More, // overflow dots
  Unlock,
  Android,
  Apple,
  Compass, // navigation
  Document, // logs
  Database, // storage
  Flask, // test
  Burst, // failures
  Bolt, // performance
  Close, // ✕
  Shrink, // collapse pane
  Diff, // open tool on all devices
}

/** The crayon glyph for each device-navigation button. */
fun DeviceButton.crayon(): CrayonGlyph =
  when (this) {
    DeviceButton.Home -> CrayonGlyph.Home
    DeviceButton.Back -> CrayonGlyph.Back
    DeviceButton.Recent -> CrayonGlyph.Recent
    DeviceButton.Power -> CrayonGlyph.Power
  }

/** The crayon glyph for each emulator control. */
fun EmulatorControl.crayon(): CrayonGlyph =
  when (this) {
    EmulatorControl.Rotate -> CrayonGlyph.Rotate
    EmulatorControl.Screenshot -> CrayonGlyph.Camera
    EmulatorControl.Snapshot -> CrayonGlyph.Layers
    EmulatorControl.Locale -> CrayonGlyph.Globe
    EmulatorControl.More -> CrayonGlyph.More
    EmulatorControl.Unlock -> CrayonGlyph.Unlock
  }

/** The crayon glyph for each facet tool. */
fun Tool.crayon(): CrayonGlyph =
  when (this) {
    Tool.Navigation -> CrayonGlyph.Compass
    Tool.Logs -> CrayonGlyph.Document
    Tool.Storage -> CrayonGlyph.Database
    Tool.Network -> CrayonGlyph.Globe
    Tool.Test -> CrayonGlyph.Flask
    Tool.Failures -> CrayonGlyph.Burst
    Tool.Performance -> CrayonGlyph.Bolt
  }

/** The crayon glyph for each device platform. */
fun Platform.crayon(): CrayonGlyph =
  when (this) {
    Platform.Android -> CrayonGlyph.Android
    Platform.Ios -> CrayonGlyph.Apple
  }

@Composable
fun CrayonIcon(glyph: CrayonGlyph, tint: Color, modifier: Modifier = Modifier) {
  Canvas(modifier) {
    val s = size.minDimension
    val st = Stroke(width = s * 0.085f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    glyphRenderers.getValue(glyph).invoke(this, tint, st, s)
  }
}

private val glyphRenderers: Map<CrayonGlyph, DrawScope.(Color, Stroke, Float) -> Unit> =
  mapOf(
    CrayonGlyph.Back to DrawScope::drawBack,
    CrayonGlyph.Home to DrawScope::drawHome,
    CrayonGlyph.Recent to DrawScope::drawRecent,
    CrayonGlyph.Power to DrawScope::drawPower,
    CrayonGlyph.PointerTap to DrawScope::drawPointerTap,
    CrayonGlyph.Inspect to DrawScope::drawInspect,
    CrayonGlyph.Rotate to DrawScope::drawRotate,
    CrayonGlyph.Camera to DrawScope::drawCamera,
    CrayonGlyph.Layers to DrawScope::drawLayers,
    CrayonGlyph.Globe to DrawScope::drawGlobe,
    CrayonGlyph.More to DrawScope::drawMore,
    CrayonGlyph.Unlock to DrawScope::drawUnlock,
    CrayonGlyph.Android to DrawScope::drawAndroid,
    CrayonGlyph.Apple to DrawScope::drawApple,
    CrayonGlyph.Compass to DrawScope::drawCompass,
    CrayonGlyph.Document to DrawScope::drawDocument,
    CrayonGlyph.Database to DrawScope::drawDatabase,
    CrayonGlyph.Flask to DrawScope::drawFlask,
    CrayonGlyph.Burst to DrawScope::drawBurst,
    CrayonGlyph.Bolt to DrawScope::drawBolt,
    CrayonGlyph.Close to DrawScope::drawClose,
    CrayonGlyph.Shrink to DrawScope::drawShrink,
    CrayonGlyph.Diff to DrawScope::drawDiff,
  )
