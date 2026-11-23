@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeRealtimeRecoveryTests: XCTestCase {
    func testUpdatePublicationFailureStillReconcilesReplacementAndLaterChannel() async throws {
        let harness = try RealtimeHarness(secondChannel: true)
        await harness.opened()
        let old = harness.transport.connections
        var channels = harness.session.resolvedChannels
        for id in ["a", "b"] {
            var declaration = try XCTUnwrap(channels[id]?.objectFields)
            declaration["url"] = .string("wss://example.com/replaced")
            channels[id] = .object(declaration)
        }
        harness.shouldThrow = { $0.channel == "a" && $0.state?.objectFields?["status"] == .string("idle") }
        try harness.replaceChannels(channels)
        await harness.module.settled()
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(old.map(\.closes), [[1001], [1001]])
        XCTAssertEqual(harness.transport.requests.map(\.channel), ["a", "b", "a", "b"])
        harness.module.update(channels)
        await harness.module.settled()
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(harness.transport.requests.count, 4) // unchanged, completed declarations stay a no-op
        harness.module.close()
        await harness.module.settled()
    }

    func testShowContinuesAfterStartupStatusFailureAndSkipsManualChannel() async throws {
        let harness = try RealtimeHarness(secondChannel: true, manualChannel: true)
        harness.shouldThrow = {
            $0.channel == "a" && $0.eventName == "realtime.status" &&
                $0.event.objectFields?["status"] == .string("connecting")
        }
        await harness.module.settled()
        harness.module.show()
        await harness.module.settled()
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(harness.transport.requests.map(\.channel), ["a", "b"])
        XCTAssertEqual(harness.attemptedEffects.filter { $0.eventName == "realtime.status" }.count, 2)
        harness.module.close()
        await harness.module.settled()
    }

    func testConnectOpensTransportAfterStatusFailure() async throws {
        let harness = try RealtimeHarness(manual: true)
        await harness.module.settled()
        harness.throwNext = true
        let result = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(result, .success(.object([:])))
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(harness.transport.connections.count, 1)
        _ = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(harness.transport.connections.count, 1)
        harness.module.close()
        await harness.module.settled()
    }

    func testOpenStatusFailureStillDrainsQueueSchedulesResetAndRunsCallback() async throws {
        let harness = try RealtimeHarness(manual: true)
        await harness.module.settled()
        var declaration = try XCTUnwrap(harness.session.resolvedChannels["a"]?.objectFields)
        declaration["onOpen"] = .array([.object(["type": .string("increment"), "key": .string("n")])])
        try harness.replaceChannels(["a": .object(declaration)])
        _ = await harness.module.call(harness.call("connect"))
        _ = await harness.module.call(harness.call("send", body: .string("first")))
        _ = await harness.module.call(harness.call("send", body: .string("second")))
        let connection = try XCTUnwrap(harness.transport.connections.first)
        harness.throwNext = true
        connection.listener.opened()
        await harness.module.settled()
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(connection.sent, ["first", "second"])
        XCTAssertEqual(harness.clock.live.map(\.delay), [5000])
        XCTAssertEqual(harness.session.state["n"], .number(1))
        harness.module.close()
        await harness.module.settled()
    }

    func testUnvalidatedStateBindingsAreCoalescingBarriers() async throws {
        // The platform case is unresolved in the controller; the runtime reads each frame's
        // published status/counters. Neither source may replace an earlier accepted write.
        for source in ["event", "platform"] {
            let harness = try RealtimeHarness()
            await harness.module.settled()
            var declaration = try XCTUnwrap(harness.session.resolvedChannels["a"]?.objectFields)
            let pointer = source == "event" ? "" : "/realtime/a/framesIn"
            let action: JSONValue = .object([
                "type": .string("setState"), "key": .string("n"),
                "value": .object([source: .string(pointer)]),
            ])
            declaration["routes"] = .array([.object(["actions": .array([action])])])
            try harness.replaceChannels(["a": .object(declaration)])
            await harness.module.settled()
            let connection = try XCTUnwrap(harness.transport.connections.last)
            connection.listener.opened()
            connection.listener.frame("2", nil, nil)
            connection.listener.frame("{\"invalid\":true}", nil, nil)
            await harness.module.settled()
            await harness.flush()
            XCTAssertEqual(harness.effects.filter { $0.actions == [action] }.count, 2)
            XCTAssertEqual(harness.session.state["n"], source == "event" ? .number(2) : .number(0))
            harness.module.close()
            await harness.module.settled()
        }
    }

    func testUnresolvedDataBindingDoesNotReplaceAcceptedScalarWrite() async throws {
        let harness = try RealtimeHarness(coalesced: true)
        await harness.opened()
        let connection = try XCTUnwrap(harness.transport.connections.first)
        connection.listener.frame("2", nil, nil)
        connection.listener.frame("null", nil, nil)
        await harness.module.settled()
        await harness.flush()
        XCTAssertEqual(harness.session.data?["latest"], .number(2))
        XCTAssertEqual(
            harness.effects.filter { $0.actions.first?.objectFields?["type"] == .string("setData") }.count,
            2
        )
        harness.module.close()
        await harness.module.settled()
    }

    func testLiteralStateWritesStillCoalesceToLastFrame() async throws {
        let harness = try RealtimeHarness()
        await harness.module.settled()
        var declaration = try XCTUnwrap(harness.session.resolvedChannels["a"]?.objectFields)
        let action: JSONValue = .object([
            "type": .string("setState"), "key": .string("n"), "value": .number(7),
        ])
        declaration["routes"] = .array([.object(["actions": .array([action])])])
        try harness.replaceChannels(["a": .object(declaration)])
        await harness.module.settled()
        let connection = try XCTUnwrap(harness.transport.connections.last)
        connection.listener.frame("1", nil, nil)
        connection.listener.frame("2", nil, nil)
        await harness.module.settled()
        await harness.flush()
        XCTAssertEqual(harness.session.state["n"], .number(7))
        let writes = harness.effects.filter { $0.actions == [action] }
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.event, .number(2))
        harness.module.close()
        await harness.module.settled()
    }

    func testFlushAttemptsEveryFrameAndCounterOnceAfterSinkFailures() async throws {
        let harness = try RealtimeHarness(secondChannel: true)
        await harness.opened()
        harness.transport.connections[0].listener.frame("1", nil, nil)
        harness.transport.connections[0].listener.frame("2", nil, nil)
        harness.transport.connections[1].listener.frame("3", nil, nil)
        await harness.module.settled()
        harness.shouldThrow = {
            ($0.event == .number(1) && !$0.actions.isEmpty) ||
                ($0.channel == "a" && $0.state != nil && $0.eventName == nil)
        }
        await harness.flush()
        XCTAssertEqual(harness.failures, 2)
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(2), .number(3)]))
        XCTAssertEqual(
            harness.session.spec?.platformState["realtime"]?.objectFields?["b"]?.objectFields?["framesIn"],
            .number(1)
        )
        XCTAssertEqual(harness.attemptedEffects.filter { $0.event == .number(1) && !$0.actions.isEmpty }.count, 1)
        let attempts = harness.attemptedEffects.count
        await harness.flush()
        XCTAssertEqual(harness.attemptedEffects.count, attempts) // failed lists and cleared dirtiness are not replayed
        harness.module.close()
        await harness.module.settled()
    }

    func testPostedStableResetCannotResetEndedConnectionAndRetryStillRuns() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        harness.transport.connections[0].listener.closed(nil, nil, nil)
        await harness.module.settled()
        try XCTUnwrap(harness.clock.live.first { $0.delay == 250 }).run()
        await harness.module.settled()
        let connection = try XCTUnwrap(harness.transport.connections.last)
        connection.listener.opened()
        await harness.module.settled()
        let reset = try XCTUnwrap(harness.clock.live.first { $0.delay == 5000 })
        // Both are posted before the inbox runs: cancelling the timer in ended cannot unpost it.
        connection.listener.closed(nil, nil, nil)
        reset.run()
        await harness.module.settled()
        XCTAssertEqual(
            harness.session.spec?.platformState["realtime"]?.objectFields?["a"]?.objectFields?["attempt"],
            .number(2)
        )
        try XCTUnwrap(harness.clock.live.first { $0.delay == 500 }).run()
        await harness.module.settled()
        XCTAssertEqual(harness.transport.connections.count, 3)
        harness.module.close()
        await harness.module.settled()
    }

    func testEndedStatusFailureStillSchedulesRetryOrRunsTerminalCallback() async throws {
        for maxAttempts in [0, 1] {
            let harness = try RealtimeHarness(maxAttempts: maxAttempts)
            await harness.module.settled()
            var declaration = try XCTUnwrap(harness.session.resolvedChannels["a"]?.objectFields)
            declaration["onClose"] = .array([.object(["type": .string("increment"), "key": .string("n")])])
            declaration["onError"] = declaration["onClose"]
            try harness.replaceChannels(["a": .object(declaration)])
            await harness.module.settled()
            let connection = try XCTUnwrap(harness.transport.connections.last)
            connection.listener.opened()
            await harness.module.settled()
            harness.throwNext = true
            connection.listener.closed(nil, nil, maxAttempts == 0 ? .init(code: "network", message: "offline") : nil)
            await harness.module.settled()
            XCTAssertEqual(harness.failures, 1)
            XCTAssertEqual(harness.session.state["n"], .number(1))
            XCTAssertEqual(harness.clock.live.map(\.delay), maxAttempts == 0 ? [] : [250])
            if maxAttempts == 1 {
                try XCTUnwrap(harness.clock.live.first).run()
                await harness.module.settled()
                XCTAssertEqual(harness.transport.connections.count, 3)
            }
            harness.module.close()
            await harness.module.settled()
        }
    }

    func testTimedOutConnectDuringStatusDoesNotOpenAndRemainsRetryable() async throws {
        let harness = try RealtimeHarness(manual: true)
        await harness.module.settled()
        await harness.mutex.lock()
        let blocked = expectation(description: "connect status is suspended on the runtime mutex")
        harness.mutex.onWait = { blocked.fulfill() }
        let driver = PrototypePlatformDriver(registry: .empty, clock: harness.clock)
        driver.realtime = harness.module
        var results: [PlatformCallResult] = []
        driver.onComplete = { _, result, _ in results.append(result) }
        driver.perform([.start(.init(call: harness.call("connect"), timeoutMs: 10))])
        await fulfillment(of: [blocked], timeout: 1)
        XCTAssertEqual(harness.module.pendingCalls, 1)
        try XCTUnwrap(harness.clock.live.first { $0.delay == 10 }).run()
        XCTAssertEqual(results, [.failure(.timeout, "Platform call timed out")])
        harness.mutex.unlock()
        await harness.module.settled()
        XCTAssertTrue(harness.transport.requests.isEmpty)
        XCTAssertEqual(harness.session.state["status"], .string("idle"))
        let live = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(live, .success(.object([:])))
        XCTAssertEqual(harness.transport.requests.count, 1)
        XCTAssertEqual(harness.session.state["status"], .string("connecting"))
        harness.module.close()
        await harness.module.settled()
    }

    func testCancelledConnectReturnsCancelledAfterSuspendedStatusAndCanRetry() async throws {
        let harness = try RealtimeHarness(manual: true)
        await harness.module.settled()
        await harness.mutex.lock()
        let blocked = expectation(description: "connect status waits on the runtime mutex")
        harness.mutex.onWait = { blocked.fulfill() }
        let call = Task { await harness.module.call(harness.call("connect")) }
        await fulfillment(of: [blocked], timeout: 1)
        call.cancel()
        harness.mutex.unlock()
        let result = await call.value
        XCTAssertEqual(result, .failure(.cancelled, "Call cancelled"))
        XCTAssertTrue(harness.transport.requests.isEmpty)
        XCTAssertEqual(harness.session.state["status"], .string("idle"))
        let live = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(live, .success(.object([:])))
        XCTAssertEqual(harness.transport.requests.count, 1)
        harness.module.close()
        await harness.module.settled()
    }
}
