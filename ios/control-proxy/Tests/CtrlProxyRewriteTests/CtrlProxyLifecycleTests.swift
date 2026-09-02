@testable import CtrlProxyRewrite
import XCTest

/// Guards the client-presence → sampler lifecycle interleaving flagged in the #5834 review.
///
/// The presence seam fires off the main actor (on the network queue) and hops back via
/// `Task { @MainActor in coordinator.applyClientPresence(...) }`. Because `stop()` blocks the
/// main actor synchronously inside `server.stop()`, a presence-`true` callback that arrives
/// during teardown queues its main-actor hop behind `stop()` and runs *after* it. Without a
/// lifecycle guard that hop would call `startSamplers()` and resurrect the hierarchy debouncer,
/// OSLog reader, and FPS monitor on an already-stopped service.
///
/// A `FakeProxyTimer` is injected so the hierarchy debouncer schedules nothing real, keeping the
/// test deterministic and fast.
@MainActor
final class CtrlProxyLifecycleTests: XCTestCase {
    func testQueuedPresenceCallbackDoesNotRestartSamplersAfterStop() {
        let proxy = CtrlProxy(hierarchyPollTimer: FakeProxyTimer(mode: .manual))

        // First client connects: samplers start.
        proxy.applyClientPresence(true)
        XCTAssertTrue(proxy.samplersActive, "first client presence should start the samplers")

        // Teardown.
        proxy.stop()
        XCTAssertFalse(proxy.samplersActive, "stop() should stop the samplers")

        // A presence-`true` callback that raced `stop()` (queued while it held the main actor)
        // now runs. It must NOT restart sampling on the stopped service.
        proxy.applyClientPresence(true)
        XCTAssertFalse(
            proxy.samplersActive,
            "a presence callback delivered after stop() must not restart the samplers"
        )
    }
}
