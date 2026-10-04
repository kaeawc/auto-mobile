@testable import AutoMobileSDK
import XCTest

final class CtrlProxyEndpointResolverTests: XCTestCase {
    func testMatchesRunnerOnDefaultPortAndCachesResult() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "simulator")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        XCTAssertEqual(resolve(resolver)?.port, 8765)
        XCTAssertEqual(resolve(resolver)?.port, 8765)
        XCTAssertEqual(probe.ports, [8765])
    }

    func testSkipsOtherSimulatorAndHierarchyPort() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "other")
        probe.respond(port: 8768, deviceId: "simulator")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        XCTAssertEqual(resolve(resolver)?.absoluteString, "http://localhost:8768/sdk-events")
        XCTAssertEqual(probe.ports, [8765, 8767, 8768])
    }

    func testSkips404EvenWithMatchingIdentity() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "simulator", statusCode: 404)
        probe.respond(port: 8768, deviceId: "simulator")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        XCTAssertEqual(resolve(resolver)?.port, 8768)
    }

    func testCaseInsensitiveIdentityMatch() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "SIMULATOR")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        XCTAssertEqual(resolve(resolver)?.port, 8765)
    }

    func testRejectsWrongMissingAndMalformedIdentityAndBoundsProbes() {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "other")
        probe.respond(port: 8767, deviceId: nil)
        probe.setResponse(port: 8768, response: CtrlProxyHealthResponse(statusCode: 200, data: Data("invalid".utf8)))
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        XCTAssertNil(resolve(resolver))
        XCTAssertEqual(probe.ports, Array(8765 ..< 8797).filter { $0 != 8766 })
    }

    func testNegativeResultUsesFakeClockForMinimumRetryInterval() {
        let probe = FakeCtrlProxyHealthProbe()
        let clock = FakeDateProvider()
        let resolver = CtrlProxyEndpointResolver(
            simulatorUdid: "simulator", healthProbe: probe, dateProvider: clock, minimumRetryInterval: 5
        )
        XCTAssertNil(resolve(resolver))
        probe.respond(port: 8765, deviceId: "simulator")
        clock.advance(by: 4.999)
        XCTAssertNil(resolve(resolver))
        XCTAssertEqual(probe.ports.count, 31)
        clock.advance(by: 0.001)
        XCTAssertEqual(resolve(resolver)?.port, 8765)
        XCTAssertEqual(probe.ports.count, 32)
    }

    func testInvalidationReprobesAndIgnoresLateFailureOfOldEndpoint() throws {
        let probe = FakeCtrlProxyHealthProbe()
        probe.respond(port: 8765, deviceId: "simulator")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        let original = try XCTUnwrap(resolve(resolver))
        resolver.invalidate(endpoint: original)
        probe.setResponse(port: 8765, response: nil)
        probe.respond(port: 8768, deviceId: "simulator")
        XCTAssertEqual(resolve(resolver)?.port, 8768)
        let count = probe.ports.count
        resolver.invalidate(endpoint: original)
        XCTAssertEqual(resolve(resolver)?.port, 8768)
        XCTAssertEqual(probe.ports.count, count)
    }

    func testNoSimulatorUsesFixedEndpointWithoutProbing() {
        let probe = FakeCtrlProxyHealthProbe()
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: nil, healthProbe: probe)
        XCTAssertEqual(resolve(resolver)?.absoluteString, "http://localhost:8765/sdk-events")
        XCTAssertTrue(probe.ports.isEmpty)
    }

    func testConcurrentResolutionsShareOneProbe() {
        let probe = FakeCtrlProxyHealthProbe(deferred: true)
        probe.respond(port: 8765, deviceId: "simulator")
        let resolver = CtrlProxyEndpointResolver(simulatorUdid: "simulator", healthProbe: probe)
        let first = ResolverResult()
        let second = ResolverResult()
        resolver.resolve { first.set($0) }
        resolver.resolve { second.set($0) }
        XCTAssertFalse(first.completed)
        XCTAssertFalse(second.completed)
        XCTAssertEqual(probe.ports, [8765])
        probe.completeNext()
        XCTAssertEqual(first.url?.port, 8765)
        XCTAssertEqual(second.url?.port, 8765)
        XCTAssertEqual(resolve(resolver)?.port, 8765)
        XCTAssertEqual(probe.ports, [8765])
    }

    private func resolve(_ resolver: CtrlProxyEndpointResolver) -> URL? {
        let result = ResolverResult()
        resolver.resolve { result.set($0) }
        XCTAssertTrue(result.completed)
        return result.url
    }
}
