@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class NavigationAdaptersConcurrencyTests: XCTestCase {
    func testNavigationTypesAreSendable() {
        func requireSendable<T: Sendable>(_: T.Type) {}

        requireSendable(NavigationAdapterHub.self)
        requireSendable(DeepLinkNavigationAdapter.self)
        requireSendable(CustomNavigationAdapter.self)
        requireSendable(BlockNavigationListener.self)
        requireSendable(SwiftUINavigationAdapter.self)
        #if canImport(UIKit) && !os(watchOS)
            requireSendable(UIKitNavigationAdapter.self)
        #endif
    }

    func testConcurrentHubStartsRetainEveryOwner() {
        let hub = NavigationAdapterHub.shared
        defer {
            for index in 0 ..< 32 {
                hub.stop(owner: "concurrency-\(index)")
            }
        }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            hub.start(owner: "concurrency-\(index)")
        }
        for index in 0 ..< 32 {
            XCTAssertTrue(hub.isActive(owner: "concurrency-\(index)"))
        }
        DispatchQueue.concurrentPerform(iterations: 32) { index in
            hub.stop(owner: "concurrency-\(index)")
        }
        for index in 0 ..< 32 {
            XCTAssertFalse(hub.isActive(owner: "concurrency-\(index)"))
        }
    }

    func testHubRedactionAndListenerDeliveryCanReenterHub() {
        struct ReentrantRedactor: NavigationDataRedacting {
            let hub: NavigationAdapterHub
            func redact(_ value: String) -> String {
                _ = hub.isActive(owner: "reentrant")
                return "redacted:\(value)"
            }
        }

        let hub = NavigationAdapterHub.shared
        let sdk = AutoMobileSDK.shared
        sdk.clearNavigationListeners()
        let events = OSAllocatedUnfairLock<[NavigationEvent]>(initialState: [])
        let listener = BlockNavigationListener { event in
            _ = hub.isActive(owner: "reentrant")
            events.withLock { $0.append(event) }
        }
        sdk.addNavigationListener(listener)
        hub.start(owner: "reentrant", redactor: ReentrantRedactor(hub: hub))
        defer {
            hub.stop(owner: "reentrant")
            // Restore the factory as well as removing this owner's activation.
            hub.start(owner: "reentrant")
            hub.stop(owner: "reentrant")
            sdk.clearNavigationListeners()
        }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            hub.record(owner: "reentrant", destination: "screen-\(index)", source: .custom)
        }
        hub.record(owner: "reentrant", destination: "unfinished", source: .custom, transitionCompleted: false)
        hub.stop(owner: "reentrant")
        hub.record(owner: "reentrant", destination: "inactive", source: .custom)

        let captured = events.withLock { $0 }
        XCTAssertEqual(captured.count, 32)
        XCTAssertEqual(Set(captured.map(\.destination)), Set((0 ..< 32).map { "redacted:screen-\($0)" }))
    }

    func testConcurrentBlockListenerCallsPreserveEveryEvent() {
        let events = OSAllocatedUnfairLock<[NavigationEvent]>(initialState: [])
        let listener = BlockNavigationListener { event in
            events.withLock { $0.append(event) }
        }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            listener.onNavigationEvent(NavigationEvent(
                destination: "screen-\(index)", source: .custom, timestamp: Int64(index)
            ))
        }

        let captured = events.withLock { $0 }
        XCTAssertEqual(captured.count, 32)
        XCTAssertEqual(Set(captured.map(\.timestamp)), Set((0 ..< 32).map { Int64($0) }))
    }

    func testConcurrentDeepLinkRecordingPreservesSourceAndArguments() {
        let adapter = DeepLinkNavigationAdapter.shared
        let sdk = AutoMobileSDK.shared
        sdk.clearNavigationListeners()
        let listener = FakeNavigationListener()
        sdk.addNavigationListener(listener)
        adapter.start()
        defer { adapter.stop(); sdk.clearNavigationListeners() }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            adapter.record(destination: "link-\(index)", arguments: ["key": "value"])
        }
        adapter.stop()
        adapter.record(destination: "inactive")

        XCTAssertEqual(listener.events.count, 32)
        XCTAssertTrue(listener.events.allSatisfy { $0.source == .deepLink && $0.arguments == ["key": "value"] })
        XCTAssertFalse(adapter.isActive)
    }

    func testConcurrentCustomRecordingKeepsCompletedTransitionsOnly() {
        let adapter = CustomNavigationAdapter.shared
        let sdk = AutoMobileSDK.shared
        sdk.clearNavigationListeners()
        let listener = FakeNavigationListener()
        sdk.addNavigationListener(listener)
        adapter.start()
        defer { adapter.stop(); sdk.clearNavigationListeners() }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            adapter.record(destination: "screen-\(index)", transitionIdentifier: "transition-\(index)")
            adapter.record(destination: "unfinished", transitionCompleted: false)
        }

        XCTAssertEqual(listener.events.count, 32)
        XCTAssertTrue(listener.events.allSatisfy { $0.source == .custom && $0.transitionCompleted })
        XCTAssertEqual(
            Set(listener.events.compactMap(\.transitionIdentifier)),
            Set((0 ..< 32).map { "transition-\($0)" })
        )
    }

    func testConcurrentSwiftUIRecordingRespectsActivationAndSource() {
        let adapter = SwiftUINavigationAdapter.shared
        let sdk = AutoMobileSDK.shared
        sdk.clearNavigationListeners()
        let listener = FakeNavigationListener()
        sdk.addNavigationListener(listener)
        adapter.start()
        defer { adapter.stop(); sdk.clearNavigationListeners() }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            adapter.trackNavigation(destination: "view-\(index)", metadata: ["key": "value"])
        }
        adapter.stop()
        adapter.trackNavigation(destination: "inactive")

        XCTAssertEqual(listener.events.count, 32)
        XCTAssertTrue(listener.events.allSatisfy { $0.source == .swiftUINavigation && $0.metadata == ["key": "value"] })
        XCTAssertFalse(adapter.isActive)
    }

    #if canImport(UIKit) && !os(watchOS)
        func testConcurrentUIKitAdapterActivationReadsNeedNoUIKitObjects() {
            let adapter = UIKitNavigationAdapter.shared
            adapter.start()
            defer { adapter.stop() }
            let activeReads = OSAllocatedUnfairLock(initialState: 0)

            DispatchQueue.concurrentPerform(iterations: 32) { _ in
                if adapter.isActive { activeReads.withLock { $0 += 1 } }
            }

            XCTAssertEqual(activeReads.withLock { $0 }, 32)
            adapter.stop()
            XCTAssertFalse(adapter.isActive)
        }
    #endif
}
