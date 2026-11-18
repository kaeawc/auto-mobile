@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeRealtimeRuntimeTests: XCTestCase {
    private func drained(_ module: PrototypeRealtimeModule) async {
        let done = expectation(description: "ordered inbox drains without deadlock")
        let task = Task { await module.settled(); done.fulfill() }
        await fulfillment(of: [done], timeout: 1)
        task.cancel()
    }

    func testPatchWhileFramesFlushUsesOuterControllerLockAndPrunesLateFrame() async throws {
        let harness = try RealtimeHarness(secondChannel: true)
        await harness.opened()
        let firstConnection = try XCTUnwrap(harness.transport.connections.first)
        let removedConnection = try XCTUnwrap(harness.transport.connections.last)
        firstConnection.listener.frame("1", nil, nil)
        firstConnection.listener.frame("2", nil, nil)
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(1), .number(2)]))

        firstConnection.listener.frame("3", nil, nil)
        removedConnection.listener.frame("99", nil, nil)
        await drained(harness.module)
        await harness.mutex.lock()
        let blocked = expectation(description: "controller waits for held runtime mutex")
        harness.mutex.onWait = { blocked.fulfill() }
        for timer in harness.clock.live where timer.delay == PrototypeChannelLimits.flushMs {
            timer.run()
        }
        await fulfillment(of: [blocked], timeout: 1) // flush now holds the controller, waiting for the runtime lock
        let (outcome, _) = harness.session.patch(id: "rt", baseRevision: harness.session.dataRevision, ops: .array([
            .object(["op": .string("replace"), "path": .string("/state/room"), "value": .string("two")]),
        ]))
        XCTAssertTrue(outcome.reply.success, outcome.reply.error ?? "")
        // Posting this under the runtime lock must return immediately, never await the controller.
        harness.module.update(harness.session.resolvedChannels)
        var remaining = harness.session.spec?.channels?.objectFields ?? [:]
        remaining["b"] = nil
        try harness.replaceChannels(remaining)
        harness.mutex.unlock()
        await drained(harness.module)
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(1), .number(2), .number(3)]))
        XCTAssertEqual(firstConnection.closes, [1001])
        XCTAssertEqual(removedConnection.closes, [1001])
        XCTAssertEqual(harness.transport.requests.last?.declaration["url"], .string("wss://example.com/two"))
        XCTAssertEqual(harness.transport.requests.last?.declaration["headers"]?.objectFields?["X-Room"], .string("two"))
        removedConnection.listener.frame("100", nil, nil) // an already pruned connection cannot produce new effects
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(1), .number(2), .number(3)]))
        harness.module.close()
        await drained(harness.module)
        XCTAssertTrue(harness.transport.connections.allSatisfy { $0.closes == [1001] })
        XCTAssertNil(harness.session.spec?.platformState["realtime"]?.objectFields?["b"])
    }

    func testStatusEventAndStatusKeyCommitTogetherBeforeFrames() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        XCTAssertEqual(harness.session.state["status"], .string("open"))
        XCTAssertEqual(
            harness.session.spec?.platformState["realtime"]?.objectFields?["a"]?.objectFields?["status"],
            .string("open")
        )
        let statuses = harness.effects.filter { $0.eventName == "realtime.status" }
        XCTAssertEqual(statuses.map { $0.event.objectFields?["status"] }, [.string("connecting"), .string("open")])
        for effect in statuses {
            XCTAssertEqual(effect.actions.first?.objectFields?["value"], effect.event.objectFields?["status"])
            XCTAssertNotNil(effect.state)
        }
        harness.transport.connections[0].listener.frame("{\"id\":1}", nil, nil)
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["frames"], .array([.object(["id": .number(1)])]))
        let statusIndex = try XCTUnwrap(
            harness.events
                .lastIndex { $0.name == "change" && $0.state["status"] == .string("open") }
        )
        let frameIndex = try XCTUnwrap(
            harness.events
                .firstIndex { $0.payload.objectFields?["event"] == .string("realtime.frame") }
        )
        XCTAssertLessThan(statusIndex, frameIndex)
        XCTAssertTrue(harness.module.state.isEmpty)
        var iterator = harness.module.events.makeAsyncIterator()
        let event = await iterator.next()
        XCTAssertNil(event)
        XCTAssertFalse(PrototypePlatformRegistry.empty.capabilities.contains("prototype_platform_realtime_v1"))
        harness.module.close()
        await drained(harness.module)
    }

    func testSinkThrowDoesNotStopLaterCallsOrClose() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        harness.throwNext = true
        harness.transport.connections[0].listener.frame("1", nil, nil)
        harness.transport.connections[0].listener.frame("2", nil, nil)
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.failures, 1)
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(2)]))
        harness.transport.connections[0].listener.frame("3", nil, nil)
        await drained(harness.module)
        harness.throwNext = true // a routed flush handler fails too; later inbox work still runs
        await harness.flush()
        XCTAssertEqual(harness.failures, 2)
        let sent = await harness.module.call(harness.call("send", body: .string("after throw")))
        XCTAssertEqual(sent, .success(.object([:])))
        XCTAssertEqual(harness.transport.connections[0].sent, ["after throw"])
        harness.module.close()
        await drained(harness.module)
        XCTAssertEqual(harness.transport.connections[0].closes, [1001])
    }

    func testTimedOutQueuedSendNeverRunsAfterRuntimeUnlocks() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        await harness.mutex.lock()
        let blocked = expectation(description: "controller waits for held runtime mutex")
        harness.mutex.onWait = { blocked.fulfill() }
        harness.transport.connections[0].listener.frame("1", nil, nil)
        await fulfillment(of: [blocked], timeout: 1)
        let driver = PrototypePlatformDriver(registry: .empty, clock: harness.clock)
        driver.realtime = harness.module
        var results: [PlatformCallResult] = []
        driver.onComplete = { _, result, _ in results.append(result) }
        driver.perform([.start(.init(call: harness.call("send", body: .string("expired")), timeoutMs: 10))])
        // Fire the deadline only after the send has entered the inbox behind the blocked frame.
        for _ in 0 ..< 1000 where harness.module.pendingCalls == 0 {
            await Task.yield()
        }
        XCTAssertEqual(harness.module.pendingCalls, 1)
        for timer in harness.clock.live where timer.delay == 10 {
            timer.run()
        }
        XCTAssertEqual(results, [.failure(.timeout, "Platform call timed out")])
        harness.mutex.unlock()
        await drained(harness.module)
        XCTAssertTrue(harness.transport.connections[0].sent.isEmpty)
        let live = await harness.module.call(harness.call("send", body: .string("live")))
        XCTAssertEqual(live, .success(.object([:])))
        XCTAssertEqual(harness.transport.connections[0].sent, ["live"])
        harness.module.close()
        await drained(harness.module)
    }

    func testManualCallsBoundedQueueDisconnectAndDismissSuppressQueuedWork() async throws {
        let harness = try RealtimeHarness(manual: true)
        await drained(harness.module)
        XCTAssertTrue(harness.transport.requests.isEmpty)
        let connected = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(connected, .success(.object([:])))
        for index in 0 ..< 32 {
            let sent = await harness.module.call(harness.call("send", body: .number(Double(index))))
            XCTAssertEqual(sent, .success(.object([:])))
        }
        let overflow = await harness.module.call(harness.call("send", body: .string("overflow")))
        XCTAssertEqual(overflow, .failure(.tooManyInFlight, "At most 32 sends may wait"))
        harness.transport.connections[0].listener.opened()
        await drained(harness.module)
        XCTAssertEqual(harness.transport.connections[0].sent, (0 ..< 32).map(String.init))
        let disconnected = await harness.module.call(harness.call("disconnect"))
        XCTAssertEqual(disconnected, .success(.object([:])))
        XCTAssertEqual(harness.transport.connections[0].closes, [1000])
        _ = await harness.module.call(harness.call("connect"))
        await harness.mutex.lock()
        let queued = Task { await harness.module.call(harness.call("send", body: .string("dismissed"))) }
        harness.module.close()
        harness.mutex.unlock()
        _ = await queued.value
        await drained(harness.module)
        XCTAssertEqual(harness.transport.connections.last?.closes, [1001])
        XCTAssertTrue(harness.transport.connections.last?.sent.isEmpty == true)
    }

    func testThrowingInitialOpenRetriesAndRecovers() async throws {
        let harness = try RealtimeHarness(manual: true)
        await harness.module.settled()
        harness.transport.failOpen = RealtimeHarness.Failure.injected
        _ = await harness.module.call(harness.call("connect"))
        XCTAssertTrue(harness.transport.requests.isEmpty)
        XCTAssertTrue(harness.transport.connections.isEmpty)
        XCTAssertEqual(harness.clock.live.map(\.delay), [250])
        XCTAssertEqual(harness.session.state["status"], .string("reconnecting"))
        harness.transport.failOpen = nil
        try XCTUnwrap(harness.clock.live.first).run()
        await harness.opened()
        XCTAssertEqual(harness.transport.requests.count, 1)
        XCTAssertEqual(harness.transport.connections.count, 1)
        XCTAssertEqual(harness.session.state["status"], .string("open"))
        harness.module.close()
        await harness.module.settled()
    }

    func testThrowingReconnectOpenSchedulesNextAttempt() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        harness.transport.connections[0].listener.closed(nil, nil, .init(code: "network", message: "offline"))
        await harness.module.settled()
        XCTAssertEqual(harness.clock.live.map(\.delay), [250])

        harness.transport.failOpen = RealtimeHarness.Failure.injected
        try XCTUnwrap(harness.clock.live.first).run()
        await harness.module.settled()
        XCTAssertEqual(harness.transport.requests.count, 1)
        XCTAssertEqual(harness.transport.connections.count, 1)
        XCTAssertEqual(harness.clock.live.map(\.delay), [500])
        XCTAssertEqual(harness.session.state["status"], .string("reconnecting"))

        harness.transport.failOpen = nil
        try XCTUnwrap(harness.clock.live.first).run()
        await harness.module.settled()
        XCTAssertEqual(harness.transport.requests.count, 2)
        XCTAssertEqual(harness.transport.connections.count, 2)
        harness.transport.connections[1].listener.opened()
        await harness.module.settled()
        XCTAssertEqual(harness.session.state["status"], .string("open"))
        harness.module.close()
        await harness.module.settled()
    }

    func testThrowingOpenExhaustsBackoffAndExplicitConnectReopens() async throws {
        let harness = try RealtimeHarness(manual: true, maxAttempts: 1)
        await harness.module.settled()
        harness.transport.failOpen = RealtimeHarness.Failure.injected
        _ = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(harness.clock.live.map(\.delay), [250])
        XCTAssertEqual(harness.session.state["status"], .string("reconnecting"))
        try XCTUnwrap(harness.clock.live.first).run()
        await harness.module.settled()
        XCTAssertTrue(harness.clock.live.isEmpty)
        XCTAssertTrue(harness.transport.requests.isEmpty)
        XCTAssertTrue(harness.transport.connections.isEmpty)
        XCTAssertEqual(harness.session.state["status"], .string("error"))

        harness.transport.failOpen = nil
        _ = await harness.module.call(harness.call("connect"))
        XCTAssertEqual(harness.transport.requests.count, 1)
        XCTAssertEqual(harness.transport.connections.count, 1)
        XCTAssertEqual(harness.session.state["status"], .string("connecting"))
        await harness.opened()
        XCTAssertEqual(harness.session.state["status"], .string("open"))
        harness.module.close()
        await harness.module.settled()
    }

    func testReconnectJitterStableResetAndFrameLimits() async throws {
        let harness = try RealtimeHarness()
        await harness.opened()
        harness.transport.connections[0].listener.closed(nil, nil, .init(code: "network", message: "offline"))
        await drained(harness.module)
        XCTAssertEqual(harness.clock.live.map(\.delay), [250])
        harness.clock.live[0].run()
        await drained(harness.module)
        XCTAssertEqual(harness.transport.connections.count, 2)
        harness.transport.connections[1].listener.opened()
        await drained(harness.module)
        XCTAssertEqual(
            harness.session.spec?.platformState["realtime"]?.objectFields?["a"]?.objectFields?["attempt"],
            .number(1)
        )
        for timer in harness.clock.live where timer.delay == 5000 {
            timer.run()
        }
        await drained(harness.module)
        harness.transport.connections[1].listener.frame("not json", nil, nil)
        harness.transport.connections[1].listener.frame(
            String(repeating: "x", count: PrototypeChannelLimits.maxFrameBytes + 1),
            nil,
            nil
        )
        await drained(harness.module)
        await harness.flush()
        let state = harness.session.spec?.platformState["realtime"]?.objectFields?["a"]?.objectFields
        XCTAssertEqual(state?["attempt"], .number(0))
        XCTAssertEqual(state?["framesDropped"], .number(2))
        let tooLarge = await harness.module.call(harness.call(
            "send",
            body: .string(String(repeating: "x", count: PrototypeChannelLimits.maxSendBytes + 1))
        ))
        XCTAssertEqual(tooLarge, .failure(.platformError, "Send exceeds maxSendBytes"))
        harness.module.close()
        await drained(harness.module)
    }

    func testCoalescingKeepsLastWholeEventAndFollowUpPlanningUsesItsEvent() async throws {
        let harness = try RealtimeHarness(coalesced: true)
        await harness.opened()
        let actions: [JSONValue] = [.object([
            "type": .string("setData"), "path": .string("/data/latest"),
            "value": .object(["event": .string("")]),
        ])]
        let connection = try XCTUnwrap(harness.transport.connections.last)
        connection.listener.opened()
        connection.listener.frame("1", nil, nil)
        connection.listener.frame("2", nil, nil)
        connection.listener.frame("3", nil, nil)
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["latest"], .number(3))
        XCTAssertEqual(harness.effects.filter { $0.actions == actions }.count, 1)
        let setState: JSONValue = .object([
            "type": .string("setState"), "key": .string("status"),
            "value": .object(["event": .string("")]),
        ])
        _ = try harness.session.runChannelActions([setState], event: .string("frame status"))
        XCTAssertEqual(harness.session.state["status"], .string("frame status"))
        // Invalid state for a bound control refuses the whole list through run(), before data writes.
        let control = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"bound","window":{"placement":{"type":"fullscreen"}},"state":{"enabled":true},
         "data":{},"root":{"type":"switch","stateKey":"enabled"}}
        """.utf8))
        var session = PrototypeSession()
        session.show(control)
        let boundState: JSONValue = .object([
            "type": .string("setState"), "key": .string("enabled"), "value": .object(["event": .string("")]),
        ])
        _ = try session.runChannelActions([boundState], event: .bool(false))
        XCTAssertEqual(session.state["enabled"], .bool(false))
        let invalid: [JSONValue] = [
            .object([
                "type": .string("setData"),
                "path": .string("/data/no"),
                "value": .object(["value": .bool(true)]),
            ]),
            .object(["type": .string("setState"), "key": .string("enabled"), "value": .object(["event": .string("")])]),
        ]
        _ = try session.runChannelActions(invalid, event: .number(2))
        XCTAssertEqual(session.state["enabled"], .bool(false))
        XCTAssertNil(session.data?["no"])
        harness.module.close()
        await drained(harness.module)
    }

    func testStateBindingsResolvePointersAndPlanLaterWritesFromResolvedValue() async throws {
        let harness = try RealtimeHarness(manual: true)
        let actions: [JSONValue] = [
            .object([
                "type": .string("setState"), "key": .string("n"),
                "value": .object(["event": .string("/count")]),
            ]),
            .object(["type": .string("increment"), "key": .string("n")]),
        ]
        _ = try harness.session.runChannelActions(actions, event: .object(["count": .number(2)]))
        XCTAssertEqual(harness.session.state["n"], .number(3))
        try harness.session.setPlatformState(["realtime": .object(["count": .number(4)])])
        let platform: JSONValue = .object([
            "type": .string("setState"), "key": .string("n"),
            "value": .object(["platform": .string("/realtime/count")]),
        ])
        _ = try harness.session.runChannelActions([platform], event: .null)
        XCTAssertEqual(harness.session.state["n"], .number(4))
        // A missing pointer or restored, absent event refuses the whole list, including increment.
        XCTAssertTrue(try harness.session.runChannelActions(actions, event: .object([:])).isEmpty)
        XCTAssertEqual(harness.session.state["n"], .number(4))
        let decoded = try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(actions))
        XCTAssertTrue(harness.session.run(decoded).isEmpty)
        XCTAssertEqual(harness.session.state["n"], .number(4))
        harness.module.close()
        await drained(harness.module)
    }

    func testSSEReconnectCarriesLastEventIDAndRefusesSend() async throws {
        let harness = try RealtimeHarness(sse: true)
        await harness.opened()
        harness.transport.connections[0].listener.frame("null", "message", "event-8")
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["frames"], .array([]))
        // Refusing a null data write must leave the channel able to process later frames.
        harness.transport.connections[0].listener.frame("1", "message", "event-9")
        await drained(harness.module)
        await harness.flush()
        XCTAssertEqual(harness.session.data?["frames"], .array([.number(1)]))
        let sent = await harness.module.call(harness.call("send", body: .string("no")))
        XCTAssertEqual(sent, .failure(.invalidArgs, "realtime.send requires a websocket and body"))
        harness.transport.connections[0].listener.closed(1000, "server ended", nil)
        await drained(harness.module)
        for timer in harness.clock.live where timer.delay == 250 {
            timer.run()
        }
        await drained(harness.module)
        XCTAssertEqual(harness.transport.requests.last?.lastEventID, "event-9")
        harness.module.close()
        await drained(harness.module)
        XCTAssertEqual(harness.transport.connections.last?.closes, [1001])
    }

    func testAbsentRuntimeConfigLeavesRealtimeUnsupported() async {
        let driver = PrototypePlatformDriver(registry: .empty, clock: RealtimeClock())
        var result: PlatformCallResult?
        driver.onComplete = { _, value, _ in result = value }
        driver.perform([.start(.init(
            call: PlatformCall(callId: "missing", call: "realtime.connect", args: ["channel": .string("a")]),
            timeoutMs: 10
        ))])
        await driver.settled()
        XCTAssertEqual(result, .failure(.unsupported, "Platform module is not registered"))
        XCTAssertFalse(driver.registry.capabilities.contains("prototype_platform_realtime_v1"))
        XCTAssertFalse(driver.registry.capabilities.contains("prototype_platform_realtime_device_v1"))
    }

    func testIndependentOwnersAndReplacementDropOldCallbacks() async throws {
        let first = try RealtimeHarness(raw: true)
        let second = try RealtimeHarness()
        await first.opened()
        await second.opened()
        first.transport.connections[0].listener.frame("raw text", nil, nil)
        await drained(first.module)
        await first.flush()
        XCTAssertEqual(first.session.data?["frames"], .array([.string("raw text")]))
        XCTAssertEqual(second.session.data?["frames"], .array([]))
        first.module.begin(prototypeID: "replacement")
        first.module.update(first.session.resolvedChannels)
        first.module.show()
        first.transport.connections[0].listener.frame("late", nil, nil)
        await drained(first.module)
        await first.flush()
        XCTAssertEqual(first.transport.connections[0].closes, [1001])
        XCTAssertEqual(first.session.data?["frames"], .array([.string("raw text")]))
        first.module.close()
        second.module.close()
        await drained(first.module)
        await drained(second.module)
    }
}
