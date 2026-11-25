@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class FakeNotificationCenterClient: NotificationCenterClient {
    var onResponse: ((PrototypeNotificationResponse) -> Void)?
    var onChange: (() -> Void)?
    var current = PrototypeNotificationSnapshot(authorization: .granted)
    var requests: [PrototypeNotificationRequest] = []
    var categories: [String: [PrototypeNotificationAction]] = [:]
    var nowEpochMs: Double = 1_700_000_000_000

    func snapshot() async -> PrototypeNotificationSnapshot { current }

    func add(_ request: PrototypeNotificationRequest) async throws {
        requests.append(request)
        let entry = PrototypeNotificationEntry(request, nowEpochMs: nowEpochMs)
        current.pending.removeAll { $0.identifier == request.identifier }
        if request.delaySeconds == nil {
            current.delivered.removeAll { $0.identifier == request.identifier }
            current.delivered.append(entry)
            if let badge = request.badge { current.badge = badge }
        } else {
            current.pending.append(entry)
        }
    }

    func remove(delivered: [String], pending: [String]) {
        current.delivered.removeAll { delivered.contains($0.identifier) }
        current.pending.removeAll { pending.contains($0.identifier) }
    }

    func setBadge(_ count: Int) async throws { current.badge = count }

    func setCategory(_ identifier: String, actions: [PrototypeNotificationAction]) async {
        categories[identifier] = actions
    }
}

private final class NotificationClock: PrototypeMonotonicClock {
    var monotonicMilliseconds = 0
}

@MainActor
final class PrototypeNotificationsModuleTests: XCTestCase {
    private let success: PlatformCallResult = .success(.object([:]))

    func testPostMapsContentAndChannelImportance() async throws {
        let (module, client) = makeModule()
        for (importance, passive) in [("min", true), ("low", true), ("default", false), ("high", false)] {
            let result = await post(module, id: importance, [
                "channel": .string(importance), "title": .string("A message"), "body": .string("Hello"),
                "group": .string("chat"), "badge": .number(12), "silent": .bool(true),
            ])
            XCTAssertEqual(result, success)
            let request = try XCTUnwrap(client.requests.last)
            XCTAssertEqual(request.identifier, "proto:viewer:\(importance)")
            XCTAssertEqual(request.title, "A message")
            XCTAssertEqual(request.body, "Hello")
            XCTAssertEqual(request.group, "chat")
            XCTAssertEqual(request.badge, 12)
            XCTAssertEqual(request.passive, passive)
            XCTAssertTrue(request.silent)
        }
    }

    func testCategoriesAreStableAcrossPostsAndChangeWithLabels() async throws {
        let (module, client) = makeModule()
        let original = makeActions(label: "Reply")
        let first = await post(module, id: "first", ["actions": original])
        let second = await post(module, id: "second", ["actions": original])
        let third = await post(module, id: "third", ["actions": makeActions(label: "Respond")])
        XCTAssertEqual([first, second, third], [success, success, success])
        let identifiers = client.requests.compactMap(\.categoryIdentifier)
        XCTAssertEqual(identifiers.count, 3)
        XCTAssertEqual(Set(identifiers.prefix(2)).count, 1)
        XCTAssertNotEqual(identifiers.first, identifiers.last)
        let reply = try XCTUnwrap(client.categories[XCTUnwrap(identifiers.first)]?.first)
        XCTAssertEqual(reply, PrototypeNotificationAction(
            id: "reply", label: "Reply", opensApp: false, replyPlaceholder: "Message"
        ))
    }

    func testDelegateRoutesOpenedActionAndReply() async {
        let (module, client) = makeModule()
        var events = module.events.makeAsyncIterator()
        let data = JSONValue.object(["conversationId": .string("42")])
        client.onResponse?(response(data: data))
        client.onResponse?(response(action: "archive", data: data))
        client.onResponse?(response(action: "reply", reply: "Hello", data: data))
        module.stop()

        let opened = await events.next()
        let action = await events.next()
        let reply = await events.next()
        XCTAssertEqual(opened, PlatformEvent(event: "notifications.opened", data: .object([
            "notificationId": .string("notice"), "data": data,
        ])))
        XCTAssertEqual(action, PlatformEvent(event: "notifications.action", data: .object([
            "notificationId": .string("notice"), "actionId": .string("archive"), "data": data,
        ])))
        XCTAssertEqual(reply, PlatformEvent(event: "notifications.reply", data: .object([
            "notificationId": .string("notice"), "actionId": .string("reply"), "reply": .string("Hello"), "data": data,
        ])))
    }

    func testColdStartQueuesUntilTheMatchingPrototypeSubscribes() async {
        let client = FakeNotificationCenterClient()
        let module = PrototypeNotificationsModule(client: client, clock: NotificationClock())
        client.onResponse?(response(prototypeId: "other"))
        client.onResponse?(response(data: .number(1)))
        configure(module)
        client.onResponse?(response(data: .number(2)))
        var events = module.events.makeAsyncIterator()
        module.stop()
        let first = await events.next()
        let second = await events.next()
        XCTAssertEqual(first?.data.objectFields?["data"], .number(1))
        XCTAssertEqual(second?.data.objectFields?["data"], .number(2))
    }

    func testPostUpdatesInPlaceAndScheduleUsesDelay() async {
        let (module, client) = makeModule()
        let first = await post(module)
        let second = await post(module, ["title": .string("Updated")])
        let scheduled = await post(module, id: "later", ["delaySeconds": .number(60)])
        XCTAssertEqual([first, second, scheduled], [success, success, success])
        XCTAssertEqual(
            client.requests.map(\.identifier),
            ["proto:viewer:notice", "proto:viewer:notice", "proto:viewer:later"]
        )
        XCTAssertEqual(client.requests.dropFirst().first?.title, "Updated")
        XCTAssertEqual(client.requests.last?.delaySeconds, 60)
        XCTAssertEqual(module.state["active"], .number(1))
        XCTAssertEqual(module.state["pending"], .number(1))
    }

    func testCancelByIdGroupAndAllOnlyRemovesMatchingPrototypeRequests() async {
        let (module, client) = makeModule()
        func entry(_ id: String, group: String = "chat", owner: String = "viewer") -> PrototypeNotificationEntry {
            PrototypeNotificationEntry(identifier: "proto:\(owner):\(id)", group: group, prototypeId: owner)
        }
        client.current.delivered = [
            entry("id"),
            entry("group"),
            entry("all", group: "another"),
            entry("id", owner: "other"),
        ]
        client.current.pending = client.current.delivered
        client.current.authorization = .denied

        let byId = await call(module, "cancel", ["id": .string("id")])
        XCTAssertEqual(byId, success)
        XCTAssertEqual(
            client.current.delivered.map(\.identifier),
            ["proto:viewer:group", "proto:viewer:all", "proto:other:id"]
        )
        XCTAssertEqual(client.current.pending.map(\.identifier), client.current.delivered.map(\.identifier))
        let byGroup = await call(module, "cancel", ["group": .string("chat")])
        XCTAssertEqual(byGroup, success)
        XCTAssertEqual(client.current.delivered.map(\.identifier), ["proto:viewer:all", "proto:other:id"])
        XCTAssertEqual(client.current.pending.map(\.identifier), client.current.delivered.map(\.identifier))
        let all = await call(module, "cancel", ["all": .bool(true)])
        XCTAssertEqual(all, success)
        XCTAssertEqual(client.current.delivered.map(\.identifier), ["proto:other:id"])
        XCTAssertEqual(client.current.pending.map(\.identifier), ["proto:other:id"])
    }

    func testSetBadgeAndDeniedAuthorization() async {
        let (module, client) = makeModule()
        let result = await call(module, "setBadge", ["count": .number(9999)])
        XCTAssertEqual(result, success)
        XCTAssertEqual(client.current.badge, 9999)
        XCTAssertEqual(module.state["badge"], .number(9999))
        XCTAssertEqual(module.state["authorization"], .string("granted"))
        client.current.authorization = .denied
        assertFailure(await post(module), .permissionDenied)
        assertFailure(await call(module, "setBadge", ["count": .number(0)]), .permissionDenied)
        XCTAssertEqual(module.state["authorization"], .string("denied"))
        XCTAssertTrue(client.requests.isEmpty)
    }

    func testBlockedChannelIsReportedAndRefused() async {
        let (module, client) = makeModule()
        client.current.blockedChannels = ["default"]
        assertFailure(await post(module), .unavailable)
        XCTAssertTrue(client.requests.isEmpty)
        XCTAssertEqual(module.state["channels"]?.objectFields?["default"], .object(["blocked": .bool(true)]))
        let unblocked = await post(module, ["channel": .string("low")])
        XCTAssertEqual(unblocked, success)
    }

    func testRejectsInvalidArgumentsAndLimitViolations() async {
        let (module, client) = makeModule()
        let action = JSONValue.object(["id": .string("open"), "label": .string("Open")])
        for args: [String: JSONValue] in [
            ["id": .string(String(repeating: "a", count: 129))],
            ["title": .string(String(repeating: "a", count: 129))],
            ["body": .string(String(repeating: "a", count: 1025))],
            ["badge": .number(10000)],
            ["actions": .array([action, action, action, action])],
            ["actions": .array([action, action])],
            ["channel": .string("missing")],
            ["delaySeconds": .number(604_801)],
        ] {
            assertFailure(await post(module, args), .invalidArgs)
        }
        assertFailure(await call(module, "cancel", ["id": .string("notice"), "all": .bool(true)]), .invalidArgs)
        assertFailure(await call(module, "setBadge", ["count": .number(10000)]), .invalidArgs)
        XCTAssertTrue(client.requests.isEmpty)

        client.current.delivered = (0 ..< 24).map {
            PrototypeNotificationEntry(identifier: "proto:viewer:\($0)", group: "", prototypeId: "viewer")
        }
        assertFailure(await post(module), .tooManyInFlight)
        let update = await post(module, id: "0")
        XCTAssertEqual(update, success)
        XCTAssertEqual(module.state["active"], .number(24))
    }

    func testPendingNotificationsReserveActiveSpace() async {
        let (module, client) = makeModule()
        client.current.delivered = (0 ..< 23).map {
            PrototypeNotificationEntry(identifier: "proto:viewer:\($0)", group: "", prototypeId: "viewer")
        }
        let scheduled = await post(module, id: "later", ["delaySeconds": .number(60)])
        XCTAssertEqual(scheduled, success)
        assertFailure(await post(module), .tooManyInFlight)
        let cancelled = await call(module, "cancel", ["id": .string("later")])
        XCTAssertEqual(cancelled, success)
        let posted = await post(module)
        XCTAssertEqual(posted, success)
    }

    func testUpdateLimitUsesMonotonicTimeAndReplyIsBoundedInUTF8() async {
        let clock = NotificationClock()
        let (module, _) = makeModule(clock: clock)
        for _ in 0 ..< 4 {
            let result = await post(module)
            XCTAssertEqual(result, success)
        }
        assertFailure(await post(module), .tooManyInFlight)
        clock.monotonicMilliseconds += 1000
        let result = await post(module)
        XCTAssertEqual(result, success)

        let (replyModule, client) = makeModule()
        var events = replyModule.events.makeAsyncIterator()
        let prefix = String(repeating: "a", count: 1023)
        client.onResponse?(response(action: "reply", reply: prefix + "🙂"))
        replyModule.stop()
        let event = await events.next()
        XCTAssertEqual(event?.data.objectFields?["reply"], .string(prefix))
    }

    func testReportListsOnlyTheShownPrototypesTaggedRequests() async {
        let (module, client) = makeModule()
        client.current.blockedChannels = ["low"]
        client.current.delivered = [
            PrototypeNotificationEntry(
                identifier: "proto:viewer:notice", group: "chat", prototypeId: "viewer", notificationId: "notice",
                channel: "high", title: "Notice", body: "Hello", actions: ["reply", "archive"], postedAt: 2000
            ),
            PrototypeNotificationEntry(
                identifier: "proto:viewer:legacy", group: "", prototypeId: "viewer", notificationId: "legacy",
                title: "Legacy", body: "", postedAt: 1000
            ),
            PrototypeNotificationEntry(
                identifier: "proto:other:notice", group: "", prototypeId: "other", notificationId: "notice",
                channel: "high", title: "Other", postedAt: 500
            ),
            PrototypeNotificationEntry(identifier: "foreign", group: "", prototypeId: "viewer", title: "Foreign"),
        ]
        client.current.pending = [
            PrototypeNotificationEntry(
                identifier: "proto:viewer:later", group: "", prototypeId: "viewer", notificationId: "later",
                channel: "default", title: "Later", fireAt: 9000
            ),
            PrototypeNotificationEntry(
                identifier: "proto:other:later", group: "", prototypeId: "other", notificationId: "later",
                fireAt: 8000
            ),
        ]
        let refreshed = await call(module, "setBadge", ["count": .number(3)])
        XCTAssertEqual(refreshed, success)

        XCTAssertEqual(module.platformReport, .object([
            "permission": .string("granted"),
            "badge": .number(3),
            "channels": .array(["default", "high", "low", "min"].map {
                .object(["id": .string($0), "importance": .string($0), "blocked": .bool($0 == "low")])
            }),
            "active": .array([
                .object([
                    "id": .string("legacy"), "channel": .string("default"), "title": .string("Legacy"),
                    "ongoing": .bool(false), "actions": .array([]), "postedAt": .number(1000),
                ]),
                .object([
                    "id": .string("notice"), "channel": .string("high"), "title": .string("Notice"),
                    "body": .string("Hello"), "group": .string("chat"), "ongoing": .bool(false),
                    "actions": .array([.string("reply"), .string("archive")]), "postedAt": .number(2000),
                ]),
            ]),
            "pending": .array([.object(["id": .string("later"), "fireAt": .number(9000)])]),
        ]))
    }

    func testPostedRequestsAreReportedBeforeTheNextRefresh() async {
        let (module, client) = makeModule()
        // The client's own times differ, so the reported times are the module's optimistic entries.
        client.nowEpochMs = 0
        let posted = await post(module, ["channel": .string("high"), "actions": makeActions(label: "Reply")])
        XCTAssertEqual(posted, success)
        XCTAssertEqual(module.platformReport?.objectFields?["active"], .array([.object([
            "id": .string("notice"), "channel": .string("high"), "title": .string("Notice"),
            "ongoing": .bool(false), "actions": .array([.string("reply")]), "postedAt": .number(Self.epochMs),
        ])]))
        let scheduled = await post(module, id: "later", ["delaySeconds": .number(60)])
        XCTAssertEqual(scheduled, success)
        XCTAssertEqual(module.platformReport?.objectFields?["pending"], .array([.object([
            "id": .string("later"), "fireAt": .number(Self.epochMs + 60000),
        ])]))
        XCTAssertEqual(client.requests.map(\.channel), ["high", "default"])
    }

    func testRegistryReportCarriesTheNotificationsReportOnly() async throws {
        let (module, _) = makeModule()
        let posted = await post(module)
        XCTAssertEqual(posted, success)
        let registry = PrototypePlatformRegistry(modules: [module, PrototypeTestPlatformModule()])

        let report = registry.report(runtime: .iosViewer, inFlight: [:])
        let notifications = try XCTUnwrap(report.modules["notifications"])
        let expected = try XCTUnwrap(module.platformReport)
        XCTAssertEqual(notifications.report, expected)
        XCTAssertNil(report.modules["test"]?.report)
        let modules = report.wireObject.objectFields?["modules"]?.objectFields
        XCTAssertEqual(modules?["notifications"], .object([
            "availability": .string("ready"), "inFlight": .number(0), "report": expected,
        ]))
        XCTAssertNil(modules?["test"]?.objectFields?["report"])
    }

    private static let epochMs: Double = 1_700_000_000_000

    private func makeModule(clock: NotificationClock = NotificationClock())
        -> (PrototypeNotificationsModule, FakeNotificationCenterClient)
    {
        let client = FakeNotificationCenterClient()
        let module = PrototypeNotificationsModule(
            client: client, clock: clock,
            epochClock: FakePrototypeEpochClock(milliseconds: Int64(Self.epochMs))
        )
        configure(module)
        return (module, client)
    }

    private func configure(_ module: PrototypeNotificationsModule) {
        module.configure(prototypeId: "viewer", block: .object([
            "channels": .array(["min", "low", "default", "high"].map {
                .object(["id": .string($0), "importance": .string($0)])
            }),
        ]))
    }

    private func makeActions(label: String) -> JSONValue {
        .array([.object([
            "id": .string("reply"), "label": .string(label), "opensApp": .bool(false),
            "reply": .object(["placeholder": .string("Message")]),
        ])])
    }

    private func response(
        prototypeId: String = "viewer", action: String? = nil, reply: String? = nil, data: JSONValue = .null
    )
        -> PrototypeNotificationResponse
    {
        PrototypeNotificationResponse(
            prototypeId: prototypeId, notificationId: "notice", actionId: action, reply: reply, data: data
        )
    }

    private func post(
        _ module: PrototypeNotificationsModule, id: String = "notice", _ overrides: [String: JSONValue] = [:]
    )
        async -> PlatformCallResult
    {
        let defaults: [String: JSONValue] = [
            "id": .string(id),
            "title": .string("Notice"),
            "channel": .string("default"),
        ]
        let args = defaults.merging(overrides) { _, value in value }
        return await call(module, args["delaySeconds"] == nil ? "post" : "schedule", args)
    }

    private func call(
        _ module: PrototypeNotificationsModule, _ operation: String, _ args: [String: JSONValue]
    )
        async -> PlatformCallResult
    {
        await module.call(PlatformCall(callId: "test", call: "notifications." + operation, args: args))
    }

    private func assertFailure(
        _ result: PlatformCallResult, _ expected: PlatformErrorCode, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard case let .failure(code, _) = result else {
            XCTFail("Expected \(expected), got \(result)", file: file, line: line)
            return
        }
        XCTAssertEqual(code, expected, file: file, line: line)
    }
}
