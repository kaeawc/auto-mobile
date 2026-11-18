@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
private final class LocationStreamActions: PrototypeLocationStreamActions {
    enum Action: Equatable {
        case accuracy(Double), start, stop, request
    }

    var actions: [Action] = []
    func setDesiredAccuracy(_ accuracy: Double) { actions.append(.accuracy(accuracy)) }
    func startUpdates() { actions.append(.start) }
    func stopUpdates() { actions.append(.stop) }
    func requestLocation() { actions.append(.request) }
}

@MainActor
final class PrototypeLocationStreamArbiterTests: XCTestCase {
    func testLastCancellationImmediatelyResumesStreamAndRestoresAccuracy() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: 1000)
        arbiter.startUpdates(using: manager)
        arbiter.requestFix(accuracy: -1, using: manager)
        XCTAssertEqual(manager.actions, [.accuracy(1000), .start, .accuracy(-1), .stop, .request])

        arbiter.cancelFix(using: manager)
        let resumed: [LocationStreamActions.Action] = [
            .accuracy(1000), .start, .accuracy(-1), .stop, .request, .accuracy(1000), .start,
        ]
        XCTAssertEqual(manager.actions, resumed)
        arbiter.finishFixes(using: manager)
        arbiter.cancelFix(using: manager)
        XCTAssertEqual(manager.actions, resumed, "Late callbacks and cancellations must not restart again")
    }

    func testFinishingOneShotResumesStreamAndRestoresAccuracy() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: 1000)
        arbiter.startUpdates(using: manager)
        arbiter.requestFix(accuracy: -1, using: manager)
        arbiter.finishFixes(using: manager)
        XCTAssertEqual(manager.actions, [
            .accuracy(1000), .start, .accuracy(-1), .stop, .request, .accuracy(1000), .start,
        ])
        let completed = manager.actions
        arbiter.finishFixes(using: manager)
        XCTAssertEqual(manager.actions, completed, "Ordinary stream fixes must not restart the stream")
    }

    func testMultipleWaitersShareRequestAndOnlyLastCancellationResumesStream() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: 1000)
        arbiter.startUpdates(using: manager)
        arbiter.requestFix(accuracy: 1000, using: manager)
        arbiter.requestFix(accuracy: -1, using: manager)
        let pending: [LocationStreamActions.Action] = [
            .accuracy(1000), .start, .accuracy(1000), .stop, .request, .accuracy(-1),
        ]
        XCTAssertEqual(manager.actions, pending)
        arbiter.cancelFix(using: manager)
        XCTAssertEqual(manager.actions, pending)
        arbiter.cancelFix(using: manager)
        XCTAssertEqual(manager.actions, pending + [.accuracy(1000), .start])
    }

    func testStoppingStreamKeepsPendingOneShotAliveWithoutResumingStreamOnFinish() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: 1000)
        arbiter.startUpdates(using: manager)
        arbiter.requestFix(accuracy: -1, using: manager)
        arbiter.stopUpdates(using: manager)
        XCTAssertEqual(manager.actions, [
            .accuracy(1000), .start, .accuracy(-1), .stop, .request, .stop, .request,
        ])
        arbiter.finishFixes(using: manager)
        XCTAssertEqual(manager.actions.last, .stop)
        XCTAssertEqual(manager.actions.filter { $0 == .start }.count, 1)
    }

    func testOneShotWithoutStreamStopsWhenCancelledAndCanRequestAgain() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: -1)
        arbiter.requestFix(accuracy: 1000, using: manager)
        arbiter.cancelFix(using: manager)
        arbiter.requestFix(accuracy: -1, using: manager)
        arbiter.finishFixes(using: manager)
        XCTAssertEqual(manager.actions, [
            .accuracy(1000), .request, .stop, .accuracy(-1), .request, .stop,
        ])
    }

    func testApproximateRequestPreservesPreciseStreamAccuracy() {
        let manager = LocationStreamActions()
        var arbiter = PrototypeLocationStreamArbiter(updateAccuracy: -1)
        arbiter.startUpdates(using: manager)
        arbiter.requestFix(accuracy: 1000, using: manager)
        arbiter.finishFixes(using: manager)
        XCTAssertEqual(manager.actions, [
            .accuracy(-1), .start, .accuracy(-1), .stop, .request, .accuracy(-1), .start,
        ])
    }
}
