@testable import AutoMobileSDK
import Foundation
import Network
import XCTest

final class SdkSimulatorServerTests: XCTestCase {
    private let udid = "ABCDEF00-1234-4567-89AB-000000000001"

    private final class Tracker: SdkHierarchyServing {
        let bundleId: String? = "test.bundle"
        var activeReads = 0
        var isApplicationActive: Bool {
            activeReads += 1
            return true
        }

        func getLatestHierarchy() -> SdkViewHierarchy? { nil }
        func walkNow() -> SdkViewHierarchy {
            XCTFail("Unexpected route invocation")
            return SdkViewHierarchy(screenScale: 1, screenWidth: 0, screenHeight: 0, root: nil)
        }
    }

    /// State is delivered explicitly after start(), matching NWListener's async contract.
    private final class Listener: SdkHierarchyListener {
        var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)?
        var newConnectionHandler: (@Sendable (NWConnection) -> Void)?
        var starts = 0
        var cancellations = 0
        func start(queue _: DispatchQueue) { starts += 1 }
        func cancel() { cancellations += 1 }
        func fail() { stateUpdateHandler?(.failed(.posix(.EADDRINUSE))) }
    }

    func testAsynchronousBindFailureProbesNextPortAndIgnoresStaleState() {
        let tracker = Tracker()
        var listeners: [Listener] = []
        var ports: [UInt16] = []
        let server = SdkHierarchyServer(
            tracker: tracker,
            identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid]),
            portListenerFactory: { port in
                ports.append(port)
                let listener = Listener()
                listeners.append(listener)
                return listener
            }
        )
        server.start()
        XCTAssertEqual(ports, [SdkSimulatorPort.simulatorPort(udid: udid), 8766])
        listeners[0].fail()
        XCTAssertEqual(ports.last, SdkSimulatorPort.simulatorPort(udid: udid, attempt: 1))
        XCTAssertEqual(listeners[0].cancellations, 1)
        listeners[0].fail()
        XCTAssertEqual(ports.count, 3, "late callbacks from a cancelled probe cannot advance discovery")
        server.stop()
        XCTAssertEqual(listeners[1].cancellations, 1)
        XCTAssertEqual(listeners[2].cancellations, 1)
        listeners[2].fail()
        XCTAssertEqual(ports.count, 3, "stop cannot be undone by a late failure")
    }

    func testAllFailedStatesExhaustWindowAndLogErrorWithSimulatorIdentity() {
        let tracker = Tracker()
        var primary: [Listener] = []
        var warnings: [String] = []
        var errors: [String] = []
        let server = SdkHierarchyServer(
            tracker: tracker,
            identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid]),
            portListenerFactory: { port in
                let listener = Listener()
                if port != 8766 { primary.append(listener) }
                return listener
            },
            warning: { warnings.append($0) },
            error: { errors.append($0) }
        )
        server.start()
        for attempt in 0 ..< SdkSimulatorPort.probeCount {
            XCTAssertEqual(primary.count, attempt + 1)
            primary[attempt].fail()
        }
        XCTAssertEqual(primary.count, SdkSimulatorPort.probeCount)
        XCTAssertTrue(warnings.isEmpty)
        XCTAssertEqual(errors.count, 1)
        XCTAssertTrue(errors.first?.contains(udid) == true)
        XCTAssertTrue(errors.first?.contains(SdkHierarchyServer.bindFailureLogPrefix) == true)
        server.stop()
    }

    func testCreationFailureProbesAndLegacyFailureIsNonFatal() {
        let tracker = Tracker()
        let primary = Listener()
        var ports: [UInt16] = []
        var warnings: [String] = []
        let first = SdkSimulatorPort.simulatorPort(udid: udid)
        let server = SdkHierarchyServer(
            tracker: tracker,
            identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid]),
            portListenerFactory: { port in
                ports.append(port)
                if port == first || port == 8766 { throw NSError(domain: NSPOSIXErrorDomain, code: 48) }
                return primary
            },
            warning: { warnings.append($0) }
        )
        server.start()
        XCTAssertEqual(ports, [first, SdkSimulatorPort.simulatorPort(udid: udid, attempt: 1), 8766])
        XCTAssertEqual(primary.starts, 1)
        XCTAssertTrue(warnings.isEmpty)
        server.stop()
        XCTAssertEqual(primary.cancellations, 1)
    }

    func testLegacyFailedStateDoesNotCancelPrimaryOrWarn() {
        let tracker = Tracker()
        let primary = Listener()
        let legacy = Listener()
        var warnings: [String] = []
        let server = SdkHierarchyServer(
            tracker: tracker,
            identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid]),
            portListenerFactory: { $0 == 8766 ? legacy : primary },
            warning: { warnings.append($0) }
        )
        server.start()
        legacy.fail()
        XCTAssertEqual(legacy.cancellations, 1)
        XCTAssertEqual(primary.cancellations, 0)
        XCTAssertTrue(warnings.isEmpty)
        server.stop()
        XCTAssertEqual(primary.cancellations, 1)
    }

    func testDerivedPortsDisableReuseAndLegacyPreservesExistingParameters() {
        XCTAssertFalse(SdkHierarchyServer.listenerParameters(
            port: SdkSimulatorPort.simulatorPort(udid: udid)
        ).allowLocalEndpointReuse)
        XCTAssertTrue(SdkHierarchyServer.listenerParameters().allowLocalEndpointReuse)
    }

    func testPhysicalDeviceBindsOnlyLegacyPort() {
        let tracker = Tracker()
        let listener = Listener()
        var ports: [UInt16] = []
        let server = SdkHierarchyServer(
            tracker: tracker,
            identity: SdkSimulatorIdentity(environment: [:]),
            portListenerFactory: { ports.append($0); return listener }
        )
        server.start()
        server.start()
        XCTAssertEqual(ports, [8766])
        server.stop()
    }

    func testMismatchRejectsBeforeForegroundBodyRoutingAndMutationAuthorization() throws {
        let tracker = Tracker()
        let server = SdkHierarchyServer(
            tracker: tracker, identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid])
        )
        // The production request pipeline runs all body readers and route/token logic
        // inside this exact continuation; rejection must never enter it.
        for route in ["/db/execute", "/preferences", "/network/mock", "/health"] {
            let rejection = try XCTUnwrap(server.authorizeRequest(
                headers: "POST \(route) HTTP/1.1\r\nx-AuToMoBiLe-Simulator-Udid: other\r\n\r\n",
                execute: { XCTFail("Wrong simulator entered body/route/token pipeline") }
            ))
            XCTAssertEqual(rejection.statusCode, 409)
            let payload = try JSONDecoder().decode([String: String].self, from: rejection.body)
            XCTAssertEqual(payload["error"], "wrong_simulator")
            XCTAssertEqual(payload["expectedUdid"], udid)
            XCTAssertEqual(payload["actualUdid"], "other")
        }
        XCTAssertEqual(tracker.activeReads, 0, "identity precedes even the foreground gate")
    }

    func testMatchingMissingAndPhysicalIdentityServeAsToday() {
        let tracker = Tracker()
        for (environment, header) in [
            (["SIMULATOR_UDID": udid], "X-AutoMobile-Simulator-Udid: \(udid.lowercased())\r\n"),
            (["SIMULATOR_UDID": udid], ""),
            ([:], "X-AutoMobile-Simulator-Udid: other\r\n"),
        ] {
            let server = SdkHierarchyServer(tracker: tracker, identity: SdkSimulatorIdentity(environment: environment))
            var served = false
            XCTAssertNil(server.authorizeRequest(headers: "GET /health HTTP/1.1\r\n\(header)\r\n") {
                served = true
            })
            XCTAssertTrue(served)
        }
    }

    func testHealthIncludesIdentityOnlyOnSimulator() throws {
        let tracker = Tracker()
        for environment in [["SIMULATOR_UDID": udid], [:]] {
            let server = SdkHierarchyServer(tracker: tracker, identity: SdkSimulatorIdentity(environment: environment))
            let response = server.healthResponse()
            XCTAssertEqual(response.statusCode, 200)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
            XCTAssertEqual(payload["simulatorUdid"] as? String, environment["SIMULATOR_UDID"])
            XCTAssertEqual(payload["status"] as? String, "ok")
            XCTAssertEqual(payload["bundleId"] as? String, "test.bundle")
        }
    }
}
