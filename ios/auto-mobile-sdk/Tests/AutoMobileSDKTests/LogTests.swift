import XCTest
@testable import AutoMobileSDK

final class AutoMobileLogTests: XCTestCase {
    override func tearDown() {
        AutoMobileLog.shared.reset()
        super.tearDown()
    }

    func testLogMethodsDoNotCrash() {
        // Log methods are thin wrappers around os.Logger.
        // Verify they don't crash when called before initialization.
        AutoMobileLog.shared.v("tag", "verbose message")
        AutoMobileLog.shared.d("tag", "debug message")
        AutoMobileLog.shared.i("tag", "info message")
        AutoMobileLog.shared.w("tag", "warning message")
        AutoMobileLog.shared.e("tag", "error message")
        AutoMobileLog.shared.fault("tag", "fault message")
    }

    func testLogMethodsWithNilTag() {
        AutoMobileLog.shared.v(nil, "verbose no tag")
        AutoMobileLog.shared.d(nil, "debug no tag")
        AutoMobileLog.shared.i(nil, "info no tag")
    }
}
