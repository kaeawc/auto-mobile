#if canImport(UIKit) && !os(watchOS)
    @testable import AutoMobileSDK
    import UIKit
    import XCTest

    final class ViewHierarchyWalkerFacadeTests: XCTestCase {
        @MainActor
        func testMainThreadWindowWalkRunsInline() {
            XCTAssertTrue(Thread.isMainThread)
            let hierarchy = ViewHierarchyWalker.walk(window: Self.makeWindow())

            XCTAssertEqual(hierarchy.root?.className, "UIWindow")
            XCTAssertEqual(
                hierarchy.root?.children?.first?.children?.first?.accessibilityIdentifier,
                "facade-child"
            )
        }

        @MainActor
        func testBackgroundWindowWalkMatchesMainThreadHash() {
            let expectedHash = ViewHierarchyWalker.computeHash(ViewHierarchyWalker.walk(window: Self.makeWindow()))
            let completed = expectation(description: "Background window walk completes")

            DispatchQueue.global().async {
                XCTAssertFalse(Thread.isMainThread)
                // Construct an equivalent fixture on main without capturing a
                // window or the XCTestCase in this Sendable background closure.
                let window = DispatchQueue.main.sync { Self.makeWindow() }
                let hierarchy = ViewHierarchyWalker.walk(window: window)
                XCTAssertEqual(hierarchy.root?.className, "UIWindow")
                XCTAssertEqual(ViewHierarchyWalker.computeHash(hierarchy), expectedHash)
                completed.fulfill()
            }

            // The synchronous XCTest wait pumps main so the main.sync hop can run.
            wait(for: [completed], timeout: 5)
        }

        @MainActor
        func testPublicWalkOnMainPreservesBundleIdAndScreenMetrics() {
            XCTAssertTrue(Thread.isMainThread)
            let hierarchy = ViewHierarchyWalker.walk(bundleId: "facade-main")

            XCTAssertEqual(hierarchy.bundleId, "facade-main")
            XCTAssertEqual(hierarchy.screenScale, Float(UIScreen.main.scale))
            XCTAssertEqual(hierarchy.screenWidth, Int(UIScreen.main.bounds.width))
            XCTAssertEqual(hierarchy.screenHeight, Int(UIScreen.main.bounds.height))
        }

        @MainActor
        func testPublicWalkInBackgroundPreservesBundleIdAndScreenMetrics() {
            let scale = Float(UIScreen.main.scale)
            let width = Int(UIScreen.main.bounds.width)
            let height = Int(UIScreen.main.bounds.height)
            let completed = expectation(description: "Background public walk completes")

            DispatchQueue.global().async {
                XCTAssertFalse(Thread.isMainThread)
                let hierarchy = ViewHierarchyWalker.walk(bundleId: "facade-background")
                XCTAssertEqual(hierarchy.bundleId, "facade-background")
                XCTAssertEqual(hierarchy.screenScale, scale)
                XCTAssertEqual(hierarchy.screenWidth, width)
                XCTAssertEqual(hierarchy.screenHeight, height)
                completed.fulfill()
            }

            wait(for: [completed], timeout: 5)
        }

        func testPureHelpersRemainCallableWithoutActorIsolation() {
            let chrome = ViewHierarchyWalker.systemChrome(
                statusBarHidden: false,
                homeIndicatorAutoHideRequested: true
            )
            let hierarchy = SdkViewHierarchy(
                timestamp: 0,
                screenScale: 2,
                screenWidth: 200,
                screenHeight: 300,
                systemChrome: chrome,
                root: nil
            )

            XCTAssertEqual(chrome.visibility, "visible")
            XCTAssertEqual(chrome.statusBar, "visible")
            XCTAssertEqual(chrome.homeIndicatorAutoHideRequested, true)
            XCTAssertEqual(ViewHierarchyWalker.computeHash(hierarchy), ViewHierarchyWalker.computeHash(hierarchy))
        }

        @MainActor
        private static func makeWindow() -> UIWindow {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 300))
            window.isHidden = false
            let container = UIView(frame: CGRect(x: 10, y: 20, width: 100, height: 80))
            let child = UIView(frame: CGRect(x: 5, y: 5, width: 30, height: 20))
            child.accessibilityIdentifier = "facade-child"
            container.addSubview(child)
            window.addSubview(container)
            return window
        }
    }
#endif
