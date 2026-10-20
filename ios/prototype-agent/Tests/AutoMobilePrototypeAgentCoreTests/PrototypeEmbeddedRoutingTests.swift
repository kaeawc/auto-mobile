@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class PrototypeEmbeddedRoutingTests: XCTestCase {
    private struct RoutingCase: Decodable {
        let name: String
        let via: String?
        let hostHandler: Bool
        let expectedRoute: String
    }

    private actor ImmediateClient: PrototypeHttpClient {
        private(set) var requests: [PrototypeHttpRequest] = []
        let failure: PrototypeRequestErrorCode?

        init(failure: PrototypeRequestErrorCode? = nil) { self.failure = failure }

        func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
            requests.append(request)
            if let failure { throw PrototypeHttpFailure(error: .init(failure, "blocked"), durationMs: 9) }
            return PrototypeHttpResponse(status: 200, headers: [:], body: Data(#""ok""#.utf8), durationMs: 9)
        }
    }

    /// AsyncStream cooperates with task cancellation without a clock, network or polling loop.
    private final class SuspendedClient: PrototypeHttpClient, Sendable {
        let started = XCTestExpectation(description: "client started")
        let cancelled = XCTestExpectation(description: "client cancelled")
        private let stream = AsyncStream<Void>.makeStream()

        func perform(_: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
            started.fulfill()
            for await _ in stream.stream {}
            cancelled.fulfill()
            throw PrototypeHttpFailure(error: .init(.cancelled, "cancelled"), durationMs: 0)
        }
    }

    private func spec(via: String? = nil) throws -> PrototypeSpec {
        let viaField = via.map { #", "via":"\#($0)""# } ?? ""
        let json = """
        {"id":"embedded","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},"data":{},
         "root":{"type":"button","label":"Go","onTap":[{"type":"request","url":"https://example.test/feed",
         "into":"/data/feed","statusKey":"status"\(viaField)}]}}
        """
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    func testSharedRoutingFixtureCompletesThroughTheSession() async throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let cases = try JSONDecoder().decode([RoutingCase].self, from: Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-embedded-routing/routing.json")
        ))
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let device = ImmediateClient()
            let handler = ImmediateClient()
            let clock = ManualRequestClock()
            let driver = PrototypeRequestDriver(
                clock: clock, device: device,
                hostRoute: testCase.hostHandler ? .handler(handler) : .deviceClient
            )
            var session = PrototypeSession()
            let spec = try spec(via: testCase.via)
            session.show(spec)
            var events: [PrototypeEvent] = []
            driver.onComplete = { id, response in
                events += session.completeRequest(id, response)
            }
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            XCTAssertEqual(session.state["status"], .string("loading"), testCase.name)
            XCTAssertEqual(driver.runningCount, 1, testCase.name)
            await driver.settled()

            let deviceCalls = await device.requests
            let handlerCalls = await handler.requests
            let useHandler = testCase.expectedRoute == "handler"
            XCTAssertEqual(deviceCalls.count, useHandler ? 0 : 1, testCase.name)
            XCTAssertEqual(handlerCalls.count, useHandler ? 1 : 0, testCase.name)
            XCTAssertEqual(session.state["status"], .string("success"), testCase.name)
            XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), .string("ok"), testCase.name)
            let requestEvent = try XCTUnwrap(events.first { $0.name == PrototypeRequestEvent.name })
            guard case let .object(event) = requestEvent.payload else {
                XCTFail("Expected request event object: \(testCase.name)")
                continue
            }
            XCTAssertEqual(event["via"], .string(testCase.via ?? "host"), testCase.name)
            XCTAssertEqual(event["outcome"], .string("success"), testCase.name)
            XCTAssertEqual(event["status"], .number(200), testCase.name)
            XCTAssertEqual(event["durationMs"], .number(9), testCase.name)
            XCTAssertEqual(driver.runningCount, 0, testCase.name)
            XCTAssertTrue(clock.handles.isEmpty, testCase.name)
        }
    }

    func testEmbeddedHostRoutesPreserveTypedClientFailures() async throws {
        for useHandler in [false, true] {
            let client = ImmediateClient(failure: .blockedDestination)
            let driver = PrototypeRequestDriver(
                clock: ManualRequestClock(), device: client,
                hostRoute: useHandler ? .handler(client) : .deviceClient
            )
            var session = PrototypeSession()
            let spec = try spec()
            session.show(spec)
            driver.onComplete = { id, response in _ = session.completeRequest(id, response) }
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await driver.settled()
            XCTAssertEqual(session.state["status"], .string("error"))
            XCTAssertEqual(
                PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta/error/code"),
                .string("blocked_destination")
            )
            XCTAssertEqual(driver.runningCount, 0)
        }
    }

    func testEmbeddedHostRoutesCancelTheirClientTasksWithoutDaemonCallbacks() async throws {
        for useHandler in [false, true] {
            let client = SuspendedClient()
            let clock = ManualRequestClock()
            let driver = PrototypeRequestDriver(
                clock: clock, device: client,
                hostRoute: useHandler ? .handler(client) : .deviceClient
            )
            var session = PrototypeSession()
            let spec = try spec()
            session.show(spec)
            driver.onComplete = { _, _ in XCTFail("Cancelled task must not deliver a response") }
            driver.onHostCancel = { _ in XCTFail("Embedded calls have no daemon cancel frame") }
            driver.onHostSettled = { _ in XCTFail("Embedded calls have no daemon connection owner") }
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await fulfillment(of: [client.started], timeout: 1)
            driver.hostDisconnected()
            XCTAssertEqual(driver.runningCount, 1)
            _ = session.dismiss(reason: .user)
            driver.perform(session.takeRequestCommands())
            await fulfillment(of: [client.cancelled], timeout: 1)
            await driver.settled()
            XCTAssertEqual(driver.runningCount, 0)
            XCTAssertTrue(clock.handles.isEmpty)
        }
    }
}
