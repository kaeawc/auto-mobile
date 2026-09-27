package dev.jasonpearson.automobile.discover.ictrace

import org.junit.Assert.assertSame
import org.junit.Test

class IcTraceViewModelTest {
  @Test
  fun `same view model retains recorder and its events`() {
    val recorder = IcTraceRecorder(nowMs = { 0L })
    val viewModel = IcTraceViewModel(recorder)
    val firstAccess = viewModel.recorder
    firstAccess.record("commitText", "text=length=1", 0, 0, -1, -1)

    assertSame(recorder, viewModel.recorder)
    assertSame(firstAccess, viewModel.recorder)
    assertSame(firstAccess.snapshot().single(), viewModel.recorder.snapshot().single())
  }
}
