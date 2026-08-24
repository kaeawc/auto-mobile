// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import XCTest

/// A stable C-convention handler used as a stand-in "previous" handler.
private let knownPreviousHandler: @convention(c) (NSException) -> Void = { _ in }

private func rawPointer(_ handler: (@convention(c) (NSException) -> Void)?) -> UnsafeRawPointer? {
    handler.map { unsafeBitCast($0, to: UnsafeRawPointer.self) }
}

final class CrashesTests: XCTestCase {
    private func makeBuffer() -> SdkEventBuffer {
        SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { _ in }
    }

    /// initialize must capture the previous handler and reset must restore it —
    /// exercising the capture that #3633 moved under the lock.
    func testInitializeCapturesPreviousHandlerAndResetRestoresIt() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        var installed: [(@convention(c) (NSException) -> Void)?] = []
        crashes.captureUncaughtHandler = { knownPreviousHandler }
        crashes.installUncaughtHandler = { installed.append($0) }

        crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        XCTAssertTrue(crashes.isInitialized)
        XCTAssertEqual(installed.count, 1) // installed our routing handler

        crashes.reset()
        XCTAssertFalse(crashes.isInitialized)
        XCTAssertEqual(installed.count, 2)
        // reset restored exactly the handler initialize captured.
        XCTAssertEqual(rawPointer(installed.last!), rawPointer(knownPreviousHandler))
    }

    /// Concurrent initialize calls are idempotent and thread-safe (the capture is
    /// now synchronized with the locked reads).
    func testConcurrentInitializeIsThreadSafe() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.captureUncaughtHandler = { nil }
        crashes.installUncaughtHandler = { _ in }
        let buffer = makeBuffer()

        DispatchQueue.concurrentPerform(iterations: 1_000) { _ in
            crashes.initialize(bundleId: "com.example", buffer: buffer)
            _ = crashes.isInitialized
        }

        XCTAssertTrue(crashes.isInitialized)
        crashes.reset()
    }

    /// Concurrent get/set/invoke of `currentScreenProvider` must not race. It was a
    /// plain `public var` read in the exception handler while written from arbitrary
    /// threads (#3632) — now serialized by the class lock, snapshotted before use.
    func testCurrentScreenProviderConcurrentAccessDoesNotCrash() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        DispatchQueue.concurrentPerform(iterations: 2_000) { i in
            crashes.currentScreenProvider = { "screen-\(i % 100)" }
            _ = crashes.currentScreenProvider
            _ = crashes.currentScreenProvider?()
        }
        XCTAssertNotNil(crashes.currentScreenProvider)
    }

    /// Replacing the provider must release the previous closure OUTSIDE the lock. If a
    /// captured object's `deinit` re-enters the (non-recursive) lock, releasing the old
    /// closure while still holding it would deadlock. This test would hang on a setter
    /// that releases under the lock; it passes only with release-after-unlock.
    func testReplacingProviderReleasesOldClosureWithoutDeadlock() {
        let crashes = AutoMobileCrashes.makeTestInstance()

        final class ReentrantSentinel {
            let crashes: AutoMobileCrashes
            let onDeinit: () -> Void
            init(_ crashes: AutoMobileCrashes, onDeinit: @escaping () -> Void) {
                self.crashes = crashes
                self.onDeinit = onDeinit
            }
            deinit {
                // Re-enter the lock via the getter as the closure is released.
                _ = crashes.currentScreenProvider
                onDeinit()
            }
        }

        var deinitRan = false
        var sentinel: ReentrantSentinel? = ReentrantSentinel(crashes) { deinitRan = true }
        crashes.currentScreenProvider = { [sentinel] in
            _ = sentinel
            return "a"
        }
        sentinel = nil // the provider closure now holds the only reference

        // Replacing the provider releases the old closure → sentinel.deinit re-enters
        // the getter. With release-under-lock this deadlocks; with the fix it returns.
        crashes.currentScreenProvider = { "b" }

        XCTAssertTrue(deinitRan, "the replaced closure's captured object was released")
        XCTAssertEqual(crashes.currentScreenProvider?(), "b")
    }
}
