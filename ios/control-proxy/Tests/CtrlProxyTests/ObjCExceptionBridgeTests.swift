import Foundation
import ObjCExceptionCatcher
import XCTest

final class ObjCExceptionBridgeTests: XCTestCase {
    #if !os(iOS)
        func testDisplayTouchOffIOSReportsSymbolsUnavailable() {
            var unavailable: ObjCBool = false
            var message: NSString?
            XCTAssertFalse(ObjCExceptionCatcher_synthesizeDisplayTouch(
                202, 508, 202, 508, 0.05, 0, 0, 2, 1, &unavailable, &message
            ))
            XCTAssertTrue(unavailable.boolValue)
            XCTAssertEqual(message as String?, "XCTest private display-targeted synthesis is only available on iOS")
        }

        func testDisplayPinchOffIOSReportsSymbolsUnavailable() {
            var unavailable: ObjCBool = false
            var message: NSString?
            let first: [NSNumber] = [458, 202, 358, 202]
            let second: [NSNumber] = [558, 202, 658, 202]
            XCTAssertFalse(ObjCExceptionCatcher_synthesizeDisplayPinch(
                first, second, 0.3, 2, 1, &unavailable, &message
            ))
            XCTAssertTrue(unavailable.boolValue)
            XCTAssertEqual(message as String?, "XCTest private display-targeted synthesis is only available on iOS")
        }

        func testDisplayInventoryOffIOSIsEmptyAndNSObjectHasNoDisplayID() {
            XCTAssertTrue((ObjCExceptionCatcher_displayInventory() ?? []).isEmpty)
            XCTAssertNil(ObjCExceptionCatcher_displayID(NSObject()))
        }
    #endif
}
