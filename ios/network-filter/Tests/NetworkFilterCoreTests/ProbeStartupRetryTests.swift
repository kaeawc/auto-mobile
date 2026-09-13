import Foundation
@testable import NetworkFilterCore
import XCTest

final class ProbeStartupRetryTests: XCTestCase {
    /// Deterministic stand-in for `DispatchProbeRetryScheduler`: nothing ever
    /// sleeps, so the backoff can be asserted exactly instead of waited out.
    private final class FakeScheduler: ProbeRetryScheduler {
        private(set) var delays: [TimeInterval] = []
        private var pending: [() -> Void] = []

        func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) {
            delays.append(delay)
            pending.append(work)
        }

        func runPending() {
            let work = pending
            pending = []
            for item in work {
                item()
            }
        }
    }

    private func connectionFailure(_ code: Int) -> ProbeStartupFailure {
        .connection(NSError(domain: NSCocoaErrorDomain, code: code))
    }

    func testStartupBackoffIsBoundedToAFewSeconds() {
        let policy = ProbeStartupRetryPolicy.startupDefault
        XCTAssertNil(policy.delay(beforeAttempt: 1))
        XCTAssertEqual(policy.delay(beforeAttempt: 2), 0.2)
        XCTAssertEqual(policy.delay(beforeAttempt: 3), 0.4)
        XCTAssertEqual(policy.delay(beforeAttempt: 4), 0.8)
        XCTAssertEqual(policy.delay(beforeAttempt: 5), 0.8)
        XCTAssertNil(policy.delay(beforeAttempt: 6))
        XCTAssertEqual(policy.totalRetryDelay, 2.2, accuracy: 0.0001)
        // The controller's own watchdog fires at 8s; startup retries must stay
        // well inside it so a bounded retry never becomes the timeout.
        XCTAssertLessThan(policy.totalRetryDelay, 3)
    }

    func testProviderNotYetListeningIsRetriedWithBackoffThenReported() {
        let scheduler = FakeScheduler()
        let coordinator = ProbeStartupRetryCoordinator(scheduler: scheduler)
        var attempts = 0

        func attempt() {
            attempts += 1
            // `NSXPCConnectionInvalid` is what macOS returns while the provider
            // has been configured but has not resumed its XPC listener yet.
            guard coordinator.scheduleRetry(after: connectionFailure(NSXPCConnectionInvalid), attempt) else {
                return
            }
            scheduler.runPending()
        }

        attempt()

        XCTAssertEqual(attempts, ProbeStartupRetryPolicy.startupDefault.maximumAttempts)
        XCTAssertEqual(scheduler.delays, [0.2, 0.4, 0.8, 0.8])
    }

    func testInterruptedConnectionIsTransientButProtocolFailuresAreTerminal() {
        let scheduler = FakeScheduler()
        XCTAssertTrue(
            ProbeStartupRetryCoordinator(scheduler: scheduler)
                .scheduleRetry(after: connectionFailure(NSXPCConnectionInterrupted)) {}
        )
        XCTAssertFalse(
            ProbeStartupRetryCoordinator(scheduler: scheduler)
                .scheduleRetry(after: connectionFailure(NSXPCConnectionReplyInvalid)) {}
        )
        XCTAssertFalse(
            ProbeStartupRetryCoordinator(scheduler: scheduler)
                .scheduleRetry(after: .connection(NSError(domain: NSOSStatusErrorDomain, code: -67050))) {}
        )
    }

    func testConnectionAndReadbackFailuresShareOneStartupBudget() {
        let scheduler = FakeScheduler()
        let coordinator = ProbeStartupRetryCoordinator(scheduler: scheduler)
        let failures: [ProbeStartupFailure] = [
            connectionFailure(NSXPCConnectionInvalid),
            .readback(ProbeReadbackStartupState.inactiveProviderMessage),
            connectionFailure(NSXPCConnectionInvalid),
            .readback(ProbeReadbackStartupState.inactiveProviderMessage),
        ]
        for failure in failures {
            XCTAssertTrue(coordinator.scheduleRetry(after: failure) {})
        }
        // The budget is spent; a fifth transient failure must be reported.
        XCTAssertFalse(
            coordinator.scheduleRetry(after: connectionFailure(NSXPCConnectionInvalid)) {}
        )
        XCTAssertEqual(scheduler.delays, [0.2, 0.4, 0.8, 0.8])
    }

    func testTerminalReadbackFailuresAreNeverRetried() {
        let scheduler = FakeScheduler()
        let coordinator = ProbeStartupRetryCoordinator(scheduler: scheduler)
        XCTAssertFalse(
            coordinator.scheduleRetry(after: .readback("Unsupported identity-probe protocol version")) {}
        )
        XCTAssertFalse(coordinator.scheduleRetry(after: .readback(nil)) {})
        XCTAssertTrue(scheduler.delays.isEmpty)
    }
}
