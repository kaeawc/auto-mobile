package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals

class DaemonBootstrapTest {

  /** Captures the bootstrap's phase listener and replays a scripted phase sequence on demand. */
  private class ScriptedLifecycle(
    private val phases: List<DaemonLifecyclePhase>,
    private val result: DaemonLifecycleResult = DaemonLifecycleResult.Ready(restarted = false),
  ) : DaemonLifecycleEnsurer {
    lateinit var listener: (DaemonLifecyclePhase) -> Unit
    var passes = 0

    override fun ensureVersionMatchedDaemon(): DaemonLifecycleResult {
      passes++
      phases.forEach(listener)
      return result
    }
  }

  private fun bootstrapOf(lifecycle: ScriptedLifecycle): DaemonBootstrap =
    DaemonBootstrap { listener ->
      lifecycle.also { it.listener = listener }
    }

  @Test
  fun `starts unknown before any lifecycle pass reports`() {
    val bootstrap = bootstrapOf(ScriptedLifecycle(emptyList()))
    assertEquals(DaemonBootstrapState.Unknown, bootstrap.state.value)
  }

  @Test
  fun `projects working phases and the ready terminal`() {
    val lifecycle =
      ScriptedLifecycle(
        listOf(
          DaemonLifecyclePhase.Probing,
          DaemonLifecyclePhase.InstallingRuntime,
          DaemonLifecyclePhase.Completed(restarted = true),
        )
      )
    val bootstrap = bootstrapOf(lifecycle)

    bootstrap.ensureReady()

    assertEquals(1, lifecycle.passes)
    assertEquals(DaemonBootstrapState.Ready(restarted = true), bootstrap.state.value)
  }

  @Test
  fun `projects a failed terminal with its message`() {
    val bootstrap =
      bootstrapOf(
        ScriptedLifecycle(
          listOf(DaemonLifecyclePhase.Probing, DaemonLifecyclePhase.Failed("no daemon"))
        )
      )

    bootstrap.ensureReady()

    assertEquals(DaemonBootstrapState.Failed("no daemon"), bootstrap.state.value)
  }

  @Test
  fun `retains the last working phase while a pass is in flight`() {
    val lifecycle = ScriptedLifecycle(emptyList())
    val bootstrap = bootstrapOf(lifecycle)

    lifecycle.listener(DaemonLifecyclePhase.LaunchingDaemon(action = "start", version = "0.0.40"))

    assertEquals(
      DaemonBootstrapState.Working(
        DaemonLifecyclePhase.LaunchingDaemon(action = "start", version = "0.0.40")
      ),
      bootstrap.state.value,
    )
  }

  @Test
  fun `a retried pass reports again after a failure`() {
    val lifecycle =
      ScriptedLifecycle(
        listOf(DaemonLifecyclePhase.Probing, DaemonLifecyclePhase.Completed(restarted = false))
      )
    val bootstrap = bootstrapOf(lifecycle)

    bootstrap.ensureReady()
    bootstrap.ensureReady()

    assertEquals(2, lifecycle.passes)
    assertEquals(DaemonBootstrapState.Ready(restarted = false), bootstrap.state.value)
  }

  @Test
  fun `a marked-inactive bootstrap never runs its lifecycle`() {
    // A configured non-daemon transport (HTTP/STDIO) marks the bootstrap inactive while the real
    // lifecycle stays installed; ensureReady must then be a no-op — never install Bun or
    // start/restart a local daemon the app is not connected to — and Inactive must not be
    // overwritten by phases.
    val lifecycle =
      ScriptedLifecycle(
        listOf(DaemonLifecyclePhase.Probing, DaemonLifecyclePhase.Completed(restarted = false))
      )
    val bootstrap = bootstrapOf(lifecycle)

    bootstrap.markInactive()
    bootstrap.ensureReady()

    assertEquals(0, lifecycle.passes)
    assertEquals(DaemonBootstrapState.Inactive, bootstrap.state.value)
  }

  @Test
  fun `inactive bootstrap stays inactive and never touches the system`() {
    val bootstrap = DaemonBootstrap.inactive()

    assertEquals(DaemonBootstrapState.Inactive, bootstrap.state.value)
    bootstrap.ensureReady()
    assertEquals(DaemonBootstrapState.Inactive, bootstrap.state.value)
  }
}
