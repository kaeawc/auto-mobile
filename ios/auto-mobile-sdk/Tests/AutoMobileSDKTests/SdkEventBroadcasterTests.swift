@testable import AutoMobileSDK
import XCTest

final class SdkEventBroadcasterTests: XCTestCase {
    /// Concurrent get/set of the CtrlProxy URL must not race. It was a plain
    /// `var` read on the flush thread while written from other threads (#3632).
    func testCtrlProxyUrlConcurrentAccessDoesNotCrash() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        DispatchQueue.concurrentPerform(iterations: 2000) { i in
            broadcaster.ctrlProxyUrl = URL(string: "http://localhost:\(8000 + i % 100)/sdk-events")
            _ = broadcaster.ctrlProxyUrl
        }
        // Final value is one of the concurrently-set URLs; the point is no crash.
        XCTAssertNotNil(broadcaster.ctrlProxyUrl)
    }

    /// Concurrent get/set of `persistence` must not race. It was a plain `var` read
    /// on the flush thread and the URLSession completion handler while written from
    /// the config/shutdown threads (#3632) — now guarded by the same config lock.
    func testPersistenceConcurrentAccessDoesNotCrash() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let fakes = (0 ..< 8).map { _ in FakeEventPersistence() }
        DispatchQueue.concurrentPerform(iterations: 2000) { i in
            broadcaster.persistence = fakes[i % fakes.count]
            _ = broadcaster.persistence
        }
        XCTAssertNotNil(broadcaster.persistence)
    }

    func testSetCtrlProxyUrlUpdatesValue() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let url = URL(string: "http://localhost:9999/sdk-events")
        broadcaster.setCtrlProxyUrl(url)
        #if DEBUG
            XCTAssertEqual(broadcaster.ctrlProxyUrl, url)
        #endif
    }

    // MARK: - persist-only-when-a-sink-exists (#3636)

    /// With no async delivery sink, the batch must NOT be written to disk (delivery
    /// is a synchronous NotificationCenter post), avoiding a write-then-delete churn.
    func testDoesNotPersistWhenNoSink() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.ctrlProxyUrl = nil

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "e1")])

        XCTAssertEqual(persistence.persistCallCount, 0)
        XCTAssertEqual(persistence.removeCallCount, 0)
    }

    /// With a sink configured, the batch is persisted (so an async-delivery failure
    /// can be replayed after a crash).
    func testPersistsWhenSinkConfigured() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.ctrlProxyUrl = URL(string: "http://localhost:1/sdk-events") // unused port; delivery fails fast

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "e1")])

        XCTAssertEqual(persistence.persistCallCount, 1)
    }

    func testUnresolvedDiscoveryPersistsWithoutPostingAndDoesNotBlockFlush() {
        let probe = FakeCtrlProxyHealthProbe()
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "pending")])

        XCTAssertEqual(persistence.batchCount, 1)
        XCTAssertTrue(transport.urls.isEmpty)
        XCTAssertTrue(probe.ports.isEmpty)
        XCTAssertEqual(executor.count, 1)
        executor.runNext()
        XCTAssertNil(broadcaster.ctrlProxyUrl)
        XCTAssertEqual(persistence.batchCount, 1)
        XCTAssertTrue(transport.urls.isEmpty)
    }

    func testResolutionTransitionReplaysPendingAndSkipsInFlightBatches() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8768, deviceId: "simulator")
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        _ = persistence.persist([SdkInteractionEvent(interactionType: "previous-launch")])

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "new")])
        executor.runNext()

        XCTAssertEqual(transport.urls.map { $0.port }, [8768, 8768])
        broadcaster.replayPending(bundleId: "com.example")
        XCTAssertEqual(transport.urls.count, 2)
        transport.completeNext(statusCode: 200)
        transport.completeNext(statusCode: 204)
        XCTAssertEqual(persistence.batchCount, 0)
    }

    func testExplicitEndpointAndExplicitNilDisableDiscovery() {
        let probe = FakeCtrlProxyHealthProbe()
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        let explicit = URL(string: "http://localhost:9999/sdk-events")
        broadcaster.setCtrlProxyUrl(explicit)
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "explicit")])
        XCTAssertEqual(transport.urls, [explicit].compactMap { $0 })
        XCTAssertEqual(executor.count, 0)
        XCTAssertTrue(probe.ports.isEmpty)

        broadcaster.ctrlProxyUrl = nil
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "disabled")])
        XCTAssertEqual(persistence.persistCallCount, 1)
        XCTAssertEqual(transport.urls.count, 1)
        XCTAssertEqual(executor.count, 0)
    }

    func testExplicitAssignmentWinsOverQueuedResolution() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8768, deviceId: "simulator")
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        broadcaster.persistence = FakeEventPersistence()
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "pending")])
        let explicit = URL(string: "http://localhost:9999/sdk-events")
        broadcaster.ctrlProxyUrl = explicit
        executor.runNext()
        XCTAssertEqual(broadcaster.ctrlProxyUrl, explicit)
        XCTAssertTrue(transport.urls.isEmpty)
    }

    func testTransportFailureInvalidatesDiscoveryAndNextReplayFindsNewPort() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "simulator")
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "restart")])
        executor.runNext()
        transport.completeNext(statusCode: 0)
        XCTAssertNil(broadcaster.ctrlProxyUrl)
        XCTAssertEqual(persistence.batchCount, 1)
        probe.setResponse(port: 8765, response: nil)
        probe.respond(port: 8768, deviceId: "simulator")
        broadcaster.replayPending(bundleId: nil)
        executor.runNext()
        XCTAssertEqual(transport.urls.map { $0.port }, [8765, 8768])
        transport.completeNext(statusCode: 200)
        XCTAssertEqual(persistence.batchCount, 0)
    }

    func testExplicitNilWinsOverHealthProbeAlreadyInProgress() {
        let probe = FakeCtrlProxyHealthProbe(deferred: true)
        probe.respond(port: 8765, deviceId: "simulator")
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "pending")])
        executor.runNext()
        XCTAssertEqual(probe.ports, [8765])
        broadcaster.ctrlProxyUrl = nil
        probe.completeNext()
        XCTAssertNil(broadcaster.ctrlProxyUrl)
        XCTAssertTrue(transport.urls.isEmpty)
        XCTAssertEqual(persistence.batchCount, 1)
    }

    func testHTTPRetryKeepsBatchInFlightUntilSuccess() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "simulator")
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = makeDiscoveringBroadcaster(probe: probe, executor: executor, transport: transport)
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "retry")])
        executor.runNext()
        transport.completeNext(statusCode: 503)
        XCTAssertEqual(executor.count, 1)
        broadcaster.replayPending(bundleId: nil)
        XCTAssertEqual(transport.urls.count, 1)
        executor.runNext()
        XCTAssertEqual(transport.urls.count, 2)
        XCTAssertEqual(probe.ports, [8765])
        transport.completeNext(statusCode: 200)
        XCTAssertEqual(persistence.batchCount, 0)
    }

    func testNegativeDiscoveryRetriesOnNextFlushOnlyAfterFakeClockInterval() {
        let probe = FakeCtrlProxyHealthProbe()
        let clock = FakeDateProvider()
        let executor = FakeEventDeliveryExecutor()
        let transport = FakeSdkEventTransport()
        let broadcaster = SdkEventBroadcaster.makeTestInstance(
            endpointResolver: CtrlProxyEndpointResolver(
                simulatorUdid: "simulator", healthProbe: probe, dateProvider: clock
            ),
            transport: transport, resolutionExecutor: { executor.enqueue($0) }
        )
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        let event = SdkInteractionEvent(interactionType: "waiting")
        broadcaster.broadcastBatch(bundleId: nil, events: [event])
        executor.runNext()
        probe.respond(port: 8765, deviceId: "simulator")
        broadcaster.broadcastBatch(bundleId: nil, events: [event])
        executor.runNext()
        XCTAssertEqual(probe.ports.count, 31)
        XCTAssertEqual(persistence.batchCount, 2)
        XCTAssertTrue(transport.urls.isEmpty)
        clock.advance(by: 5)
        broadcaster.replayPending(bundleId: nil)
        executor.runNext()
        XCTAssertEqual(probe.ports.count, 32)
        XCTAssertEqual(transport.urls.count, 2)
    }

    func testHostUsesFixedEndpointWithoutDiscovery() {
        let probe = FakeCtrlProxyHealthProbe()
        let transport = FakeSdkEventTransport()
        let broadcaster = SdkEventBroadcaster.makeTestInstance(
            endpointResolver: CtrlProxyEndpointResolver(simulatorUdid: nil, healthProbe: probe),
            transport: transport, resolutionExecutor: { $0() }
        )
        broadcaster.broadcastBatch(bundleId: nil, events: [SdkInteractionEvent(interactionType: "host")])
        XCTAssertEqual(transport.urls.first?.port, 8765)
        XCTAssertTrue(probe.ports.isEmpty)
    }

    private func makeDiscoveringBroadcaster(
        probe: FakeCtrlProxyHealthProbe,
        executor: FakeEventDeliveryExecutor,
        transport: FakeSdkEventTransport
    )
        -> SdkEventBroadcaster
    {
        SdkEventBroadcaster.makeTestInstance(
            endpointResolver: CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe),
            transport: transport,
            resolutionExecutor: { executor.enqueue($0) },
            retryExecutor: { _, work in executor.enqueue(work) }
        )
    }
}
