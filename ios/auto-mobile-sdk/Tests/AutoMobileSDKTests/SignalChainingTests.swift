// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import os
import XCTest

// Issue #10141: crash-signal handlers must be installed with sigaction + SA_SIGINFO and
// chain to the previous action with the arguments that action expects. No test raises a
// fatal signal: install/uninstall run against a fake kernel table, and the end-to-end
// tests use SIGUSR1, which has a handler for the duration of the test.

/// What a recording previous handler observed. Global because `@convention(c)` closures
/// cannot capture state; tests run serially and reset it in `setUp`.
private struct SignalCall: Equatable {
    var signal: Int32
    var info: UInt
    var context: UInt
}

private let recordedSigInfoCalls = OSAllocatedUnfairLock(initialState: [SignalCall]())
private let recordedPlainCalls = OSAllocatedUnfairLock(initialState: [Int32]())

private let recordingSigInfoHandler: SignalInfoHandler = { sig, info, context in
    let call = SignalCall(signal: sig, info: UInt(bitPattern: info), context: UInt(bitPattern: context))
    recordedSigInfoCalls.withLock { $0.append(call) }
}

private let recordingPlainHandler: SignalPlainHandler = { sig in
    recordedPlainCalls.withLock { $0.append(sig) }
}

private let otherSigInfoHandler: SignalInfoHandler = { _, _, _ in }

private func raw(_ handler: SignalInfoHandler?) -> UnsafeRawPointer? {
    handler.map { unsafeBitCast($0, to: UnsafeRawPointer.self) }
}

private func raw(_ handler: SignalPlainHandler?) -> UnsafeRawPointer? {
    handler.map { unsafeBitCast($0, to: UnsafeRawPointer.self) }
}

private func sigInfoAction(_ handler: SignalInfoHandler?, flags: Int32 = 0, mask: sigset_t = 0) -> sigaction {
    var action = sigaction()
    action.__sigaction_u.__sa_sigaction = handler
    action.sa_flags = SA_SIGINFO | flags
    action.sa_mask = mask
    return action
}

private func plainAction(_ handler: SignalPlainHandler?, flags: Int32 = 0) -> sigaction {
    var action = sigaction()
    action.__sigaction_u.__sa_handler = handler
    action.sa_flags = flags
    return action
}

private func rawHandlerAction(_ value: Int) -> sigaction {
    var action = sigaction()
    action.__sigaction_u.__sa_handler = unsafeBitCast(value, to: SignalPlainHandler?.self)
    return action
}

/// Stand-in for the kernel's per-signal action table.
private final class FakeKernel {
    var actions: [Int32: sigaction] = [:]
    var writes: [(signal: Int32, action: sigaction)] = []
    var failWrites = false

    lazy var call: SigactionCall = { [weak self] signalNumber, newAction, oldAction in
        guard let self else { return -1 }
        if let oldAction {
            oldAction.pointee = actions[signalNumber] ?? sigaction()
        }
        if let newAction {
            if failWrites { return -1 }
            actions[signalNumber] = newAction.pointee
            writes.append((signalNumber, newAction.pointee))
        }
        return 0
    }

    /// The handler a foreign reporter would have registered after the SDK did.
    func installForeign(_ signalNumber: Int32, handler: SignalInfoHandler) {
        actions[signalNumber] = sigInfoAction(handler, flags: SA_ONSTACK)
    }
}

final class SignalChainingTests: XCTestCase {
    private var kernel: FakeKernel!
    private let monitored: [Int32] = [SIGUSR1, SIGUSR2]
    private let fakeContext = UnsafeMutableRawPointer(bitPattern: 0xBEEF)

    override func setUp() {
        super.setUp()
        kernel = FakeKernel()
        autoMobileSignalTable.resetForTesting()
        recordedSigInfoCalls.withLock { $0.removeAll() }
        recordedPlainCalls.withLock { $0.removeAll() }
    }

    override func tearDown() {
        autoMobileSignalTable.resetForTesting()
        super.tearDown()
    }

    private func makeCrashes() -> AutoMobileCrashes {
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.sigactionCall = kernel.call
        crashes.signalsToMonitor = monitored
        return crashes
    }

    // MARK: - Pure chain decision

    func testSigInfoPreviousIsInvokedWithThreeArguments() {
        let action = sigInfoAction(recordingSigInfoHandler, flags: SA_ONSTACK)
        guard case let .invokeSigInfo(handler) = chainAction(forPrevious: action) else {
            return XCTFail("expected invokeSigInfo")
        }
        XCTAssertEqual(raw(handler), raw(recordingSigInfoHandler))
    }

    func testPlainPreviousIsInvokedWithOneArgument() {
        guard case let .invokePlain(handler) = chainAction(forPrevious: plainAction(recordingPlainHandler)) else {
            return XCTFail("expected invokePlain")
        }
        XCTAssertEqual(raw(handler), raw(recordingPlainHandler))
    }

    func testDefaultPreviousRestoresDefaultAndReraises() {
        guard case .restoreDefaultAndReraise = chainAction(forPrevious: rawHandlerAction(0)) else {
            return XCTFail("expected restoreDefaultAndReraise")
        }
        guard case .restoreDefaultAndReraise = chainAction(forPrevious: sigaction()) else {
            return XCTFail("a zeroed action is SIG_DFL")
        }
    }

    func testIgnorePreviousIsIgnored() {
        guard case .ignore = chainAction(forPrevious: rawHandlerAction(1)) else {
            return XCTFail("expected ignore")
        }
    }

    func testSigErrPreviousFallsBackToDefault() {
        guard case .restoreDefaultAndReraise = chainAction(forPrevious: rawHandlerAction(-1)) else {
            return XCTFail("SIG_ERR is not a real handler")
        }
    }

    func testSigInfoFlagWithNilHandlerFallsBackToDefault() {
        guard case .restoreDefaultAndReraise = chainAction(forPrevious: sigInfoAction(nil)) else {
            return XCTFail("a nil SA_SIGINFO handler must not be called")
        }
    }

    func testSigInfoFlagSelectsUnionMemberRegardlessOfSentinelBits() {
        // With SA_SIGINFO the bits are a function pointer even if they look like SIG_IGN.
        var action = rawHandlerAction(1)
        action.sa_flags = SA_SIGINFO
        guard case .invokeSigInfo = chainAction(forPrevious: action) else {
            return XCTFail("SA_SIGINFO must win over sentinel interpretation")
        }
    }

    func testInstallFlagsAlwaysSigInfoAndOnstackAndInheritOnlyNodefer() {
        let plain = signalInstallFlags(previous: plainAction(recordingPlainHandler))
        XCTAssertEqual(plain, SA_SIGINFO | SA_ONSTACK)

        let busy = signalInstallFlags(previous: plainAction(
            recordingPlainHandler,
            flags: SA_NODEFER | SA_RESETHAND | SA_RESTART
        ))
        XCTAssertEqual(busy, SA_SIGINFO | SA_ONSTACK | SA_NODEFER)
    }

    // MARK: - Install / uninstall against a fake kernel

    func testInstallSavesFullPreviousActionAndRegistersSigInfoHandler() {
        let previous = sigInfoAction(recordingSigInfoHandler, flags: SA_ONSTACK | SA_NODEFER, mask: 0x42)
        kernel.actions[SIGUSR1] = previous
        let crashes = makeCrashes()

        crashes.installSignalHandlers()

        let table = autoMobileSignalTable
        let saved = table.previousActions[Int(SIGUSR1)]
        XCTAssertEqual(saved.sa_flags, previous.sa_flags)
        XCTAssertEqual(saved.sa_mask, 0x42)
        XCTAssertEqual(raw(saved.__sigaction_u.__sa_sigaction), raw(recordingSigInfoHandler))
        XCTAssertEqual(table.slotState[Int(SIGUSR1)], 1)

        let installed = kernel.actions[SIGUSR1]!
        XCTAssertTrue(isOwnSignalAction(installed))
        XCTAssertEqual(installed.sa_flags, SA_SIGINFO | SA_ONSTACK | SA_NODEFER)
        XCTAssertEqual(installed.sa_mask, 0x42, "the previous action's blocked-signal mask is kept")
        // A slot whose previous action was SIG_DFL is saved too, so the chain can restore it.
        XCTAssertEqual(table.slotState[Int(SIGUSR2)], 1)
        XCTAssertEqual(table.recording.pointee, 1)
    }

    func testInstallingTwiceDoesNotReinstallOrCaptureItself() {
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler)
        let crashes = makeCrashes()

        crashes.installSignalHandlers()
        crashes.installSignalHandlers()

        XCTAssertEqual(kernel.writes.count, monitored.count)
        // A second instance sees our handler already current: it must not save it.
        let second = makeCrashes()
        second.installSignalHandlers()
        XCTAssertEqual(kernel.writes.count, monitored.count)
        let saved = autoMobileSignalTable.previousActions[Int(SIGUSR1)]
        XCTAssertEqual(raw(saved.__sigaction_u.__sa_sigaction), raw(recordingSigInfoHandler))
    }

    func testUninstallRestoresSavedActionsWhenOursIsStillCurrent() {
        let previous = sigInfoAction(recordingSigInfoHandler, flags: SA_ONSTACK, mask: 0x7)
        kernel.actions[SIGUSR1] = previous
        let crashes = makeCrashes()
        crashes.installSignalHandlers()

        crashes.uninstallSignalHandlers()

        let restored = kernel.actions[SIGUSR1]!
        XCTAssertEqual(raw(restored.__sigaction_u.__sa_sigaction), raw(recordingSigInfoHandler))
        XCTAssertEqual(restored.sa_flags, previous.sa_flags)
        XCTAssertEqual(restored.sa_mask, 0x7)
        XCTAssertFalse(isOwnSignalAction(kernel.actions[SIGUSR2] ?? sigaction()))
        XCTAssertEqual(autoMobileSignalTable.slotState[Int(SIGUSR1)], 0)
        XCTAssertEqual(autoMobileSignalTable.recording.pointee, 0)
    }

    func testUninstallDoesNotClobberHandlerInstalledAfterOurs() {
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler)
        let crashes = makeCrashes()
        crashes.installSignalHandlers()
        kernel.installForeign(SIGUSR1, handler: otherSigInfoHandler)
        let writesBefore = kernel.writes.count

        crashes.uninstallSignalHandlers()

        XCTAssertEqual(raw(kernel.actions[SIGUSR1]!.__sigaction_u.__sa_sigaction), raw(otherSigInfoHandler))
        // Only the slot that is still ours (SIGUSR2) was written back.
        XCTAssertEqual(kernel.writes.count, writesBefore + 1)
        XCTAssertEqual(kernel.writes.last?.signal, SIGUSR2)
        // The later reporter chains through us, so the saved predecessor stays available.
        XCTAssertEqual(autoMobileSignalTable.slotState[Int(SIGUSR1)], 1)
        XCTAssertEqual(autoMobileSignalTable.recording.pointee, 0, "dormant forwarder must not record")
    }

    func testReinstallAfterDormantUninstallReactivatesInPlaceWithoutCycle() {
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler)
        let crashes = makeCrashes()
        crashes.installSignalHandlers()
        kernel.installForeign(SIGUSR1, handler: otherSigInfoHandler)
        crashes.uninstallSignalHandlers()

        crashes.installSignalHandlers()

        XCTAssertEqual(raw(kernel.actions[SIGUSR1]!.__sigaction_u.__sa_sigaction), raw(otherSigInfoHandler))
        let saved = autoMobileSignalTable.previousActions[Int(SIGUSR1)]
        XCTAssertEqual(
            raw(saved.__sigaction_u.__sa_sigaction),
            raw(recordingSigInfoHandler),
            "the foreign reporter must not become our predecessor"
        )
        XCTAssertEqual(autoMobileSignalTable.recording.pointee, 1)
        XCTAssertTrue(isOwnSignalAction(kernel.actions[SIGUSR2]!), "restored slot is reinstalled")
    }

    func testUninstallWithoutInstallTouchesNothing() {
        let crashes = makeCrashes()
        crashes.uninstallSignalHandlers()
        XCTAssertTrue(kernel.writes.isEmpty)
    }

    func testResetUninstallsSignalHandlersEvenWhenNeverInitialized() {
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler)
        let crashes = makeCrashes()
        crashes.installSignalHandlers()
        XCTAssertFalse(crashes.isInitialized)

        crashes.reset()

        XCTAssertEqual(raw(kernel.actions[SIGUSR1]!.__sigaction_u.__sa_sigaction), raw(recordingSigInfoHandler))
    }

    func testFailedInstallLeavesNoSavedSlot() {
        let crashes = makeCrashes()
        kernel.failWrites = true

        crashes.installSignalHandlers()

        XCTAssertEqual(autoMobileSignalTable.slotState[Int(SIGUSR1)], 0)
    }

    // MARK: - Handler entry point

    func testHandlerPassesSameSiginfoAndContextToSigInfoPrevious() {
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler, flags: SA_ONSTACK)
        makeCrashes().installSignalHandlers()
        var info = siginfo_t()
        info.si_signo = SIGUSR1

        withUnsafeMutablePointer(to: &info) { pointer in
            autoMobileSignalHandler(SIGUSR1, pointer, fakeContext)
            let calls = recordedSigInfoCalls.withLock { $0 }
            XCTAssertEqual(calls, [SignalCall(
                signal: SIGUSR1,
                info: UInt(bitPattern: pointer),
                context: UInt(bitPattern: fakeContext)
            )])
        }
        XCTAssertTrue(recordedPlainCalls.withLock { $0.isEmpty })
    }

    func testHandlerPassesOnlySignalToPlainPrevious() {
        kernel.actions[SIGUSR1] = plainAction(recordingPlainHandler)
        makeCrashes().installSignalHandlers()
        var info = siginfo_t()

        autoMobileSignalHandler(SIGUSR1, &info, fakeContext)

        XCTAssertEqual(recordedPlainCalls.withLock { $0 }, [SIGUSR1])
        XCTAssertTrue(recordedSigInfoCalls.withLock { $0.isEmpty })
    }

    func testHandlerHonoursSigIgnPredecessorOnFirstDelivery() {
        kernel.actions[SIGUSR1] = rawHandlerAction(1)
        makeCrashes().installSignalHandlers()
        var info = siginfo_t()

        autoMobileSignalHandler(SIGUSR1, &info, nil) // returns: nothing raised, nothing chained

        XCTAssertEqual(autoMobileSignalTable.ignoredOnce[Int(SIGUSR1)], 1)
        XCTAssertTrue(recordedSigInfoCalls.withLock { $0.isEmpty })
        XCTAssertTrue(recordedPlainCalls.withLock { $0.isEmpty })
        XCTAssertEqual(autoMobileSignalTable.depth.pointee, 0, "depth is restored when the handler returns")
    }

    func testHandlerRecordsSignalOnlyWhileEnabled() throws {
        let path = NSTemporaryDirectory() + "automobile_signal_chaining_\(UUID().uuidString)"
        defer { unlink(path) }
        XCTAssertTrue(autoMobileSignalTable.setCrashFilePath(path))
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler)
        let crashes = makeCrashes()
        crashes.installSignalHandlers()
        var info = siginfo_t()

        autoMobileSignalTable.recording.pointee = 0 // what a dormant (post-uninstall) forwarder looks like
        autoMobileSignalHandler(SIGUSR1, &info, nil)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "a dormant forwarder records nothing")

        autoMobileSignalTable.recording.pointee = 1
        autoMobileSignalHandler(SIGUSR1, &info, nil)
        let data = try XCTUnwrap(FileManager.default.contents(atPath: path))
        XCTAssertEqual(data.withUnsafeBytes { $0.load(as: Int32.self) }, SIGUSR1)
        XCTAssertEqual(recordedSigInfoCalls.withLock { $0.count }, 2, "chaining continues either way")
    }

    func testOversizedCrashFilePathIsRejected() {
        let tooLong = String(repeating: "a", count: SignalHandlerTable.pathCapacity)
        XCTAssertFalse(autoMobileSignalTable.setCrashFilePath(tooLong))
        XCTAssertEqual(autoMobileSignalTable.pathReady.pointee, 0)
    }

    func testResetHandPreviousIsResetToDefaultBeforeInvocation() {
        // Real SIGUSR1 action, restored afterwards: emulating SA_RESETHAND calls sigaction.
        var original = sigaction()
        sigaction(SIGUSR1, nil, &original)
        defer { sigaction(SIGUSR1, &original, nil) }
        var sentinel = sigInfoAction(otherSigInfoHandler)
        sigaction(SIGUSR1, &sentinel, nil)
        kernel.actions[SIGUSR1] = sigInfoAction(recordingSigInfoHandler, flags: SA_RESETHAND)
        makeCrashes().installSignalHandlers()
        var info = siginfo_t()

        autoMobileSignalHandler(SIGUSR1, &info, nil)

        var current = sigaction()
        sigaction(SIGUSR1, nil, &current)
        XCTAssertNil(raw(current.__sigaction_u.__sa_handler), "SA_RESETHAND resets to SIG_DFL")
        XCTAssertEqual(recordedSigInfoCalls.withLock { $0.count }, 1)
    }

    // MARK: - End to end through the real kernel (SIGUSR1)

    func testRealSignalDeliversSiginfoToSigInfoPreviousAndRoundTripsOnUninstall() throws {
        var original = sigaction()
        sigaction(SIGUSR1, nil, &original)
        defer { sigaction(SIGUSR1, &original, nil) }
        var previous = sigInfoAction(recordingSigInfoHandler, flags: SA_ONSTACK)
        XCTAssertEqual(sigaction(SIGUSR1, &previous, nil), 0)
        let path = NSTemporaryDirectory() + "automobile_signal_chaining_\(UUID().uuidString)"
        defer { unlink(path) }
        XCTAssertTrue(autoMobileSignalTable.setCrashFilePath(path))
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.signalsToMonitor = [SIGUSR1]

        crashes.installSignalHandlers()
        var installed = sigaction()
        sigaction(SIGUSR1, nil, &installed)
        XCTAssertTrue(isOwnSignalAction(installed))
        XCTAssertNotEqual(installed.sa_flags & SA_ONSTACK, 0)

        XCTAssertEqual(raise(SIGUSR1), 0)

        let calls = recordedSigInfoCalls.withLock { $0 }
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.signal, SIGUSR1)
        XCTAssertNotEqual(calls.first?.info, 0, "the previous reporter got a real siginfo_t")
        XCTAssertNotEqual(calls.first?.context, 0, "the previous reporter got a real ucontext")
        let data = try XCTUnwrap(FileManager.default.contents(atPath: path))
        XCTAssertEqual(data.withUnsafeBytes { $0.load(as: Int32.self) }, SIGUSR1)

        crashes.uninstallSignalHandlers()
        var restored = sigaction()
        sigaction(SIGUSR1, nil, &restored)
        XCTAssertEqual(raw(restored.__sigaction_u.__sa_sigaction), raw(recordingSigInfoHandler))
        XCTAssertNotEqual(restored.sa_flags & SA_SIGINFO, 0)
    }

    func testRealSignalDeliversOnlySignalToPlainPrevious() {
        var original = sigaction()
        sigaction(SIGUSR1, nil, &original)
        defer { sigaction(SIGUSR1, &original, nil) }
        var previous = plainAction(recordingPlainHandler)
        XCTAssertEqual(sigaction(SIGUSR1, &previous, nil), 0)
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.signalsToMonitor = [SIGUSR1]
        crashes.installSignalHandlers()
        defer { crashes.uninstallSignalHandlers() }

        XCTAssertEqual(raise(SIGUSR1), 0)

        XCTAssertEqual(recordedPlainCalls.withLock { $0 }, [SIGUSR1])
    }
}
