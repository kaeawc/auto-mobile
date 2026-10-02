#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import Foundation
    import Network
    import XCTest

    final class SdkServerBindStateTests: XCTestCase {
        private let udid = "ABCDEF00-1234-4567-89AB-000000000001"

        private final class Tracker: SdkHierarchyServing {
            let bundleId: String? = "test.bundle"
            let isApplicationActive = true
            func getLatestHierarchy() -> SdkViewHierarchy? { nil }
            func walkNow() -> SdkViewHierarchy {
                XCTFail("Bind tests must not request a hierarchy")
                return SdkViewHierarchy(screenScale: 1, screenWidth: 0, screenHeight: 0, root: nil)
            }
        }

        private final class Listener: SdkHierarchyListener, @unchecked Sendable {
            var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)?
            var newConnectionHandler: (@Sendable (NWConnection) -> Void)?
            private let automaticState: NWListener.State?
            private let ready: XCTestExpectation?

            init(automaticState: NWListener.State? = nil, ready: XCTestExpectation? = nil) {
                self.automaticState = automaticState
                self.ready = ready
            }

            func start(queue: DispatchQueue) {
                guard automaticState != nil else { return }
                let handler = stateUpdateHandler
                queue.async { [self] in
                    guard let state = automaticState else { return }
                    handler?(state)
                    if case .ready = state { ready?.fulfill() }
                }
            }

            func cancel() {}
            func report(_ state: NWListener.State) { stateUpdateHandler?(state) }
        }

        private struct Snapshot {
            let ports: [UInt16]
            let primary: [Listener]
            let legacy: Listener?
            let errors: [String]
            let warnings: [String]
        }

        /// The async tests record attempts and logs through a lock, rather than
        /// capturing mutable arrays in Network's sendable callbacks.
        private final class Harness: @unchecked Sendable {
            let tracker = Tracker()
            private let lock = NSLock()
            private var attempts: [UInt16] = []
            private var primary: [Listener] = []
            private var legacy: Listener?
            private var errors: [String] = []
            private var warnings: [String] = []

            var snapshot: Snapshot {
                lock.lock()
                defer { lock.unlock() }
                return Snapshot(ports: attempts, primary: primary, legacy: legacy, errors: errors, warnings: warnings)
            }

            func server(
                udid: String?, automaticStates: [NWListener.State] = [], finished: XCTestExpectation? = nil
            )
                -> SdkHierarchyServer
            {
                SdkHierarchyServer(
                    tracker: tracker,
                    identity: SdkSimulatorIdentity(environment: udid.map { ["SIMULATOR_UDID": $0] } ?? [:]),
                    portListenerFactory: { port in
                        self.lock.lock()
                        defer { self.lock.unlock() }
                        let isLegacy = udid != nil && port == SdkHierarchyServer.port
                        let index = self.primary.count
                        let state = !isLegacy && index < automaticStates.count ? automaticStates[index] : nil
                        let listener = Listener(automaticState: state, ready: finished)
                        if isLegacy {
                            self.legacy = listener
                        } else {
                            self.attempts.append(port)
                            self.primary.append(listener)
                        }
                        return listener
                    },
                    warning: { message in
                        self.lock.lock()
                        self.warnings.append(message)
                        self.lock.unlock()
                    },
                    error: { message in
                        self.lock.lock()
                        self.errors.append(message)
                        self.lock.unlock()
                        finished?.fulfill()
                    }
                )
            }
        }

        private var ports: [UInt16] {
            (0 ..< SdkSimulatorPort.probeCount).map { SdkSimulatorPort.simulatorPort(udid: udid, attempt: $0) }
        }

        func testFirstCandidateReadyRecordsStartedAndOneAttempt() throws {
            let harness = Harness()
            let server = harness.server(udid: udid)
            XCTAssertEqual(server.bindState, .notStarted)
            server.start()
            defer { server.stop() }
            XCTAssertEqual(server.bindState, .starting)
            try XCTUnwrap(harness.snapshot.primary.first).report(.ready)
            XCTAssertEqual(server.bindState, .started(port: ports[0]))
            XCTAssertEqual(harness.snapshot.ports, [ports[0]])
            XCTAssertTrue(harness.snapshot.errors.isEmpty)
        }

        func testSecondCandidateReadyThroughAsynchronousCallbacks() {
            let harness = Harness()
            let finished = expectation(description: "second candidate ready")
            let server = harness.server(
                udid: udid, automaticStates: [.failed(.posix(.EADDRINUSE)), .ready], finished: finished
            )
            server.start()
            defer { server.stop() }
            wait(for: [finished], timeout: 0.05)
            XCTAssertEqual(server.bindState, .started(port: ports[1]))
            XCTAssertEqual(harness.snapshot.ports, Array(ports.prefix(2)))
            XCTAssertTrue(harness.snapshot.errors.isEmpty)
        }

        func testAllCandidatesFailThroughAsynchronousCallbacksAndLogOnce() throws {
            let harness = Harness()
            let finished = expectation(description: "all candidates failed")
            let lastError = NWError.posix(.EACCES)
            let states: [NWListener.State] = Array(
                repeating: .failed(.posix(.EADDRINUSE)), count: SdkSimulatorPort.probeCount - 1
            ) + [.failed(lastError)]
            let server = harness.server(udid: udid, automaticStates: states, finished: finished)
            server.start()
            defer { server.stop() }
            wait(for: [finished], timeout: 0.05)
            let failedState = SdkServerBindState.failed(
                attemptedPorts: ports,
                lastReason: String(describing: lastError)
            )
            XCTAssertEqual(server.bindState, failedState)
            XCTAssertEqual(harness.snapshot.ports, ports)
            XCTAssertEqual(harness.snapshot.errors.count, 1)
            let message = try XCTUnwrap(harness.snapshot.errors.first)
            XCTAssertTrue(message.hasPrefix(SdkHierarchyServer.bindFailureLogPrefix))
            XCTAssertTrue(message.contains(udid))
            XCTAssertTrue(message.contains(String(describing: lastError)))
            for port in ports {
                XCTAssertTrue(message.contains(String(port)))
            }
            XCTAssertTrue(harness.snapshot.warnings.isEmpty)

            // Legacy callbacks cannot replace the terminal primary failure or log it again.
            try XCTUnwrap(harness.snapshot.legacy).report(.ready)
            try XCTUnwrap(harness.snapshot.legacy).report(.failed(.posix(.EADDRINUSE)))
            XCTAssertEqual(server.bindState, failedState)
            XCTAssertEqual(harness.snapshot.errors.count, 1)
            let stale = try XCTUnwrap(harness.snapshot.primary.last).stateUpdateHandler
            stale?(.failed(.posix(.EACCES)))
            XCTAssertEqual(harness.snapshot.errors.count, 1)
            server.stop()
            XCTAssertEqual(server.bindState, .notStarted)
            stale?(.failed(.posix(.EADDRINUSE)))
            XCTAssertEqual(server.bindState, .notStarted)
            XCTAssertEqual(harness.snapshot.errors.count, 1)
        }

        func testDeviceFailureRecordsSolePortAndAllowsRestart() throws {
            let harness = Harness()
            let server = harness.server(udid: nil)
            server.start()
            defer { server.stop() }
            let error = NWError.posix(.EADDRINUSE)
            let first = try XCTUnwrap(harness.snapshot.primary.first)
            first.report(.failed(error))
            XCTAssertEqual(server.bindState, .failed(attemptedPorts: [8766], lastReason: String(describing: error)))
            XCTAssertEqual(harness.snapshot.ports, [8766])
            XCTAssertEqual(harness.snapshot.errors.count, 1)
            XCTAssertTrue(harness.snapshot.errors.first?.hasPrefix(SdkHierarchyServer.bindFailureLogPrefix) == true)
            XCTAssertTrue(harness.snapshot.warnings.isEmpty)
            server.start()
            XCTAssertEqual(server.bindState, .starting)
            first.report(.failed(error))
            XCTAssertEqual(harness.snapshot.errors.count, 1)
            try XCTUnwrap(harness.snapshot.primary.last).report(.ready)
            XCTAssertEqual(server.bindState, .started(port: 8766))
        }

        func testLegacyFailurePreservesStartingAndStartedPrimary() throws {
            let harness = Harness()
            let server = harness.server(udid: udid)
            server.start()
            defer { server.stop() }
            let legacy = try XCTUnwrap(harness.snapshot.legacy)
            legacy.report(.ready)
            XCTAssertEqual(server.bindState, .starting)
            try XCTUnwrap(harness.snapshot.primary.first).report(.ready)
            legacy.report(.failed(.posix(.EADDRINUSE)))
            XCTAssertEqual(server.bindState, .started(port: ports[0]))
            XCTAssertTrue(harness.snapshot.errors.isEmpty)
            XCTAssertTrue(harness.snapshot.warnings.isEmpty)
        }

        func testFactoryThrowsExhaustCandidatesAndPreservesLastError() {
            let tracker = Tracker()
            var attempted: [UInt16] = []
            var errors: [String] = []
            var warnings: [String] = []
            let lastError = NWError.posix(.EACCES)
            let server = SdkHierarchyServer(
                tracker: tracker,
                identity: SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid]),
                portListenerFactory: { port in
                    if port == SdkHierarchyServer.port { throw NWError.posix(.EADDRINUSE) }
                    attempted.append(port)
                    throw attempted.count == SdkSimulatorPort.probeCount ? lastError : NWError.posix(.EADDRINUSE)
                },
                warning: { warnings.append($0) },
                error: { errors.append($0) }
            )
            server.start()
            defer { server.stop() }
            XCTAssertEqual(attempted, ports)
            XCTAssertEqual(server.bindState, .failed(attemptedPorts: ports, lastReason: String(describing: lastError)))
            XCTAssertEqual(errors.count, 1)
            XCTAssertTrue(warnings.isEmpty)
        }

        func testPlannerIsPureAndReturnsOrderedBindEffects() {
            let initial = SdkBindPlanner()
            let first = initial.next(.start, udid: udid)
            XCTAssertEqual(initial.state, .notStarted)
            XCTAssertEqual(first.port, ports[0])
            let second = first.planner.next(.failed("first error"), udid: udid)
            XCTAssertEqual(second.port, ports[1])
            XCTAssertEqual(second.planner.attemptedPorts, Array(ports.prefix(2)))
            let ready = second.planner.next(.ready(ports[1]), udid: udid)
            XCTAssertNil(ready.port)
            XCTAssertEqual(ready.planner.state, .started(port: ports[1]))
        }
    }
#endif
