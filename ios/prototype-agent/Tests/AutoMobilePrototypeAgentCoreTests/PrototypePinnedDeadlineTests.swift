@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePinnedDeadlineTests: XCTestCase {
    func testDeadlineDuringDNSReturnsWithoutWaitingForLookup() async {
        let deadlines = FakePinnedDeadline()
        let resolver = SuspendedPinnedResolver()
        let connector = FakePinnedConnector([])
        let transport = PrototypePinnedHttpClient(resolver: resolver, connector: connector, deadlines: deadlines)
        let task = Task { try await transport.perform(pinnedRequest()) }
        await resolver.entered.wait()
        deadlines.fire()
        do { _ = try await task.value; XCTFail("Completed expired DNS") }
        catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .timeout) }
        resolver.release.release()
        await resolver.finished.wait()
        XCTAssertTrue(connector.dials.isEmpty)
    }

    func testDeadlineDuringConnectCancelsLateConnectionBeforeSending() async {
        let deadlines = FakePinnedDeadline()
        let connector = SuspendedPinnedConnector()
        let transport = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(),
            connector: connector,
            deadlines: deadlines
        )
        let task = Task { try await transport.perform(pinnedRequest()) }
        await connector.entered.wait()
        deadlines.fire()
        do { _ = try await task.value; XCTFail("Completed expired connection") }
        catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .timeout) }
        connector.release.release()
        await connector.cancelled.wait()
        XCTAssertTrue(connector.connection.cancelled)
        XCTAssertTrue(connector.connection.sent.isEmpty)
    }

    func testDurationUsesInjectedClock() async throws {
        let time = PinnedTestTime()
        let connection = FakePinnedConnection()
        connection.onReceive = { time.set(145) }
        let transport = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(),
            connector: FakePinnedConnector([connection]),
            deadlines: FakePinnedDeadline(),
            nowMs: { time.now }
        )
        let response = try await transport.perform(pinnedRequest())
        XCTAssertEqual(response.durationMs, 45)
    }
}

private final class SuspendedPinnedResolver: HostResolving, Sendable {
    let entered = FakePinnedSignal()
    let release = FakePinnedSignal()
    let finished = FakePinnedSignal()
    func addresses(for _: String) async throws -> [String] {
        entered.release()
        await release.wait()
        defer { finished.release() }
        return ["8.8.8.8"]
    }
}

private final class SuspendedPinnedConnector: PrototypePinnedConnecting, Sendable {
    let entered = FakePinnedSignal()
    let release = FakePinnedSignal()
    let cancelled = FakePinnedSignal()
    let connection: FakePinnedConnection
    init() {
        let connection = FakePinnedConnection()
        let cancelled = self.cancelled
        connection.onCancel = { cancelled.release() }
        self.connection = connection
    }

    func connect(
        address _: String,
        port _: Int,
        tlsServerName _: String?
    )
        async throws -> any PrototypePinnedConnection
    {
        entered.release()
        await release.wait()
        return connection
    }
}

private final class PinnedTestTime: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 100.0
    var now: Double { lock.withLock { value } }
    func set(_ value: Double) { lock.withLock { self.value = value } }
}
