@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class FakeDNSTimer: PrototypeDNSDeadlineScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (@Sendable () -> Void)?
    private(set) var milliseconds: Int?
    private(set) var cancelled = false

    func schedule(afterMilliseconds: Int, _ fire: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        lock.withLock {
            milliseconds = afterMilliseconds
            callback = fire
        }
        return { self.lock.withLock { self.cancelled = true } }
    }

    func fire() { lock.withLock { callback }?() }
}

private final class FakeDNSWorker: PrototypeDNSWorking, @unchecked Sendable {
    let submitted = XCTestExpectation(description: "DNS submitted")
    private let lock = NSLock()
    private var work: (@Sendable () -> Void)?

    func submit(_ work: @escaping @Sendable () -> Void) -> Bool {
        let accepted = lock.withLock {
            guard self.work == nil else { return false }
            self.work = work
            return true
        }
        if accepted { submitted.fulfill() }
        return accepted
    }

    func run() {
        lock.withLock { work }?()
        lock.withLock { work = nil }
    }
}

final class PrototypeDNSResolverTests: XCTestCase {
    func testTimeoutBeforeWorkerStartsSkipsLookupAndKeepsAdmissionBounded() async {
        let worker = FakeDNSWorker()
        let timer = FakeDNSTimer()
        let resolver = PrototypeSystemHostResolver(timeoutMs: 37, worker: worker, deadlines: timer) { _ in
            XCTFail("Timed-out queued work performed a lookup")
            return []
        }
        let result = Task { try await resolver.addresses(for: "public.example") }
        await fulfillment(of: [worker.submitted], timeout: 1)
        XCTAssertEqual(timer.milliseconds, 37)
        timer.fire()
        do {
            _ = try await result.value
            XCTFail("Lookup did not time out")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        XCTAssertTrue(timer.cancelled)
        for _ in 0 ..< 100 {
            XCTAssertFalse(worker.submit { XCTFail("Extra work admitted") })
        }
        worker.run()
        // A late timeout callback is harmless and cannot resume the continuation twice.
        timer.fire()
    }

    func testTimeoutDuringLookupIgnoresLateAnswerAndDoesNotReleaseWorkerEarly() async {
        let worker = FakeDNSWorker()
        let timer = FakeDNSTimer()
        let resolver = PrototypeSystemHostResolver(worker: worker, deadlines: timer) { _ in
            timer.fire()
            XCTAssertFalse(worker.submit { XCTFail("Admitted while lookup still running") })
            return ["8.8.8.8"]
        }
        let result = Task { try await resolver.addresses(for: "public.example") }
        await fulfillment(of: [worker.submitted], timeout: 1)
        worker.run()
        do {
            _ = try await result.value
            XCTFail("Delivered the late answer")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
    }

    func testSuccessAndLookupFailureCancelDeadline() async {
        for fails in [false, true] {
            let worker = FakeDNSWorker()
            let timer = FakeDNSTimer()
            let resolver = PrototypeSystemHostResolver(worker: worker, deadlines: timer) { host in
                XCTAssertEqual(host, "public.example")
                if fails { throw URLError(.cannotFindHost) }
                return ["8.8.8.8", "1.1.1.1"]
            }
            let result = Task { try await resolver.addresses(for: "public.example") }
            await fulfillment(of: [worker.submitted], timeout: 1)
            worker.run()
            do {
                let addresses = try await result.value
                XCTAssertFalse(fails)
                XCTAssertEqual(addresses, ["8.8.8.8", "1.1.1.1"])
            } catch {
                XCTAssertTrue(fails)
                XCTAssertEqual((error as? URLError)?.code, .cannotFindHost)
            }
            XCTAssertTrue(timer.cancelled)
            timer.fire()
        }
    }

    func testBusyWorkerFailsImmediatelyAndCancelsDeadline() async {
        let worker = FakeDNSWorker()
        XCTAssertTrue(worker.submit {})
        let timer = FakeDNSTimer()
        let resolver = PrototypeSystemHostResolver(worker: worker, deadlines: timer) { _ in
            XCTFail("Busy worker performed lookup")
            return []
        }
        do {
            _ = try await resolver.addresses(for: "public.example")
            XCTFail("Busy worker succeeded")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .cannotFindHost)
        }
        XCTAssertTrue(timer.cancelled)
    }

    func testSerialWorkerDoesNotQueueMoreWorkWhileLookupRuns() async {
        let worker = PrototypeDNSWorker()
        let entered = expectation(description: "Lookup started")
        let finished = expectation(description: "Lookup finished")
        let release = DispatchSemaphore(value: 0)
        XCTAssertTrue(worker.submit {
            entered.fulfill()
            release.wait()
            finished.fulfill()
        })
        await fulfillment(of: [entered], timeout: 1)
        for _ in 0 ..< 100 {
            XCTAssertFalse(worker.submit { XCTFail("Additional lookup started") })
        }
        release.signal()
        await fulfillment(of: [finished], timeout: 1)
    }
}
