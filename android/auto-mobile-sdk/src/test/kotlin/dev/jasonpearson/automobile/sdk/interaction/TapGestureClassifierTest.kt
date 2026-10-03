package dev.jasonpearson.automobile.sdk.interaction

import dev.jasonpearson.automobile.sdk.interaction.TapGestureClassifier.Action
import dev.jasonpearson.automobile.sdk.interaction.TapGestureClassifier.Result.NoDecision
import dev.jasonpearson.automobile.sdk.interaction.TapGestureClassifier.Result.NotTap
import dev.jasonpearson.automobile.sdk.interaction.TapGestureClassifier.Result.Tap
import kotlin.test.assertEquals
import org.junit.Test

class TapGestureClassifierTest {

  private val classifier = TapGestureClassifier(slopPx = 20, timeoutMs = 500L)

  @Test
  fun `tap within slop and time returns UP coordinates and duration`() {
    assertEquals(NoDecision, classifier.classify(Action.DOWN, 100f, 200f, 1000L))
    assertEquals(Tap(105f, 210f, 100L), classifier.classify(Action.UP, 105f, 210f, 1100L))
  }

  @Test
  fun `movement exactly at slop is not a tap`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(NotTap, classifier.classify(Action.UP, 120f, 200f, 1100L))
  }

  @Test
  fun `movement just inside slop is a tap`() {
    classifier.classify(Action.DOWN, 0f, 0f, 1000L)
    assertEquals(Tap(19.999f, 0f, 100L), classifier.classify(Action.UP, 19.999f, 0f, 1100L))
  }

  @Test
  fun `UP beyond slop is not a tap`() {
    classifier.classify(Action.DOWN, 0f, 0f, 1000L)
    assertEquals(NotTap, classifier.classify(Action.UP, 21f, 0f, 1100L))
  }

  @Test
  fun `duration exactly at timeout is not a tap`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(NotTap, classifier.classify(Action.UP, 100f, 200f, 1500L))
  }

  @Test
  fun `duration just under timeout is a tap`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(Tap(100f, 200f, 499L), classifier.classify(Action.UP, 100f, 200f, 1499L))
  }

  @Test
  fun `long press beyond timeout is not a tap`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(NotTap, classifier.classify(Action.UP, 100f, 200f, 2000L))
  }

  @Test
  fun `pointer DOWN and UP do not overwrite or reset the first DOWN`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    // POINTER_DOWN and POINTER_UP are both mapped to OTHER by the tracker.
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 1050L))
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 1100L))
    assertEquals(Tap(105f, 205f, 200L), classifier.classify(Action.UP, 105f, 205f, 1200L))
  }

  @Test
  fun `CANCEL does not clear the previous DOWN`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 1050L))
    assertEquals(Tap(100f, 200f, 100L), classifier.classify(Action.UP, 100f, 200f, 1100L))
  }

  @Test
  fun `CANCEL without prior DOWN leaves initial state and UP is not a tap`() {
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 100f, 200f, 1000L))
    assertEquals(NotTap, classifier.classify(Action.UP, 0f, 0f, 1100L))
  }

  @Test
  fun `UP without DOWN is not a tap with an epoch timestamp`() {
    assertEquals(NotTap, classifier.classify(Action.UP, 0f, 0f, 1_700_000_000_000L))
  }

  @Test
  fun `second UP after a tap is judged against the same DOWN`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(Tap(105f, 205f, 100L), classifier.classify(Action.UP, 105f, 205f, 1100L))
    assertEquals(Tap(110f, 210f, 200L), classifier.classify(Action.UP, 110f, 210f, 1200L))
    assertEquals(NotTap, classifier.classify(Action.UP, 100f, 200f, 1500L))
  }

  @Test
  fun `second DOWN overwrites position and time of the first gesture`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    classifier.classify(Action.DOWN, 900f, 800f, 2000L)
    assertEquals(Tap(905f, 805f, 100L), classifier.classify(Action.UP, 905f, 805f, 2100L))
  }

  @Test
  fun `diagonal slop uses the sum of both squared axes`() {
    classifier.classify(Action.DOWN, 0f, 0f, 1000L)
    assertEquals(Tap(12f, 15f, 100L), classifier.classify(Action.UP, 12f, 15f, 1100L))
    assertEquals(NotTap, classifier.classify(Action.UP, 12f, 16f, 1100L))
    assertEquals(NotTap, classifier.classify(Action.UP, 15f, 15f, 1100L))
  }

  @Test
  fun `negative deltas use the same squared distance`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(Tap(88f, 185f, 100L), classifier.classify(Action.UP, 88f, 185f, 1100L))
    assertEquals(NotTap, classifier.classify(Action.UP, 88f, 184f, 1100L))
  }

  @Test
  fun `MOVE beyond slop and back is ignored and still permits a tap`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 1050L))
    assertEquals(Tap(100f, 200f, 100L), classifier.classify(Action.UP, 100f, 200f, 1100L))
  }

  @Test
  fun `ignored events return no decision before and after a gesture`() {
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 500L))
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    classifier.classify(Action.UP, 100f, 200f, 1100L)
    assertEquals(NoDecision, classifier.classify(Action.OTHER, 900f, 800f, 1150L))
    assertEquals(Tap(100f, 200f, 200L), classifier.classify(Action.UP, 100f, 200f, 1200L))
  }

  @Test
  fun `constructor thresholds control the strict comparisons`() {
    val classifier = TapGestureClassifier(slopPx = 5, timeoutMs = 10L)
    classifier.classify(Action.DOWN, 0f, 0f, 1000L)
    assertEquals(Tap(4f, 0f, 9L), classifier.classify(Action.UP, 4f, 0f, 1009L))
    assertEquals(NotTap, classifier.classify(Action.UP, 5f, 0f, 1009L))
    assertEquals(NotTap, classifier.classify(Action.UP, 4f, 0f, 1010L))
  }

  @Test
  fun `backward clock retains the original negative duration behavior`() {
    classifier.classify(Action.DOWN, 100f, 200f, 1000L)
    assertEquals(Tap(100f, 200f, -1L), classifier.classify(Action.UP, 100f, 200f, 999L))
  }
}
