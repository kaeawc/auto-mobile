@testable import CtrlProxy
import XCTest

final class OSLogNoiseFilterTests: XCTestCase {
    func testFiltersOSLogServiceConnectionLifecycle() {
        let messages = [
            "[connection] [0x...] activating connection: mach=false listener=false peer=false name=com.apple.OSLogService",
            "[connection] [0x...] invalidated because the current process cancelled the connection by calling xpc_connection_cancel()",
        ]
        for message in messages {
            XCTAssertTrue(OSLogReader.isSelfGeneratedNoise(
                subsystem: "com.apple.xpc", category: "connection", message: message
            ), message)
        }
    }

    func testFiltersNetworkConnectionsAndListeners() {
        let fixtures = [
            ("connection", "nw_association_create_flow <nw_association 127.0.0.1:51795> Added association flow ID ..."),
            (
                "connection",
                "nw_endpoint_flow_setup_protocols [C29 127.0.0.1:51795 initial socket-flow (satisfied (Path is satisfied), interface: lo0)] ..."
            ),
            (
                "listener",
                "-[NWConcrete_nw_listener handleInbound:addProtocolInbox:] [L1] Handling inbound connection (add inbox 0) [C29 127.0.0.1:51795 tcp ..."
            ),
        ]
        for (category, message) in fixtures {
            XCTAssertTrue(OSLogReader.isSelfGeneratedNoise(
                subsystem: "com.apple.network", category: category, message: message
            ), message)
        }
        XCTAssertTrue(OSLogReader.isSelfGeneratedNoise(
            subsystem: "com.apple.network", category: "connection", message: "interface: lo0"
        ))
    }

    func testFiltersNetworkConnectionsWithoutLoopbackMarkers() {
        let messages = [
            "nw_connection_create_with_connected_socket_internal [C4] create connection to connected fd <fd_wr...",
            "nw_connection_set_progress_handler_block_invoke [C4] Setting progress handler 0x0",
            "nw_connection_report_state_with_handler_on_nw_queue [C4] reporting state preparing",
            "nw_connection_start_candidate_manager_if_needed_locked [C4] Checking whether to start candidate m...",
            "nw_connection_report_state_with_handler_on_nw_queue [C4] reporting state ready",
            "nw_connection_report_state_with_handler_on_nw_queue [C4] reporting state cancelled",
        ]
        for message in messages {
            XCTAssertTrue(OSLogReader.isSelfGeneratedNoise(
                subsystem: "com.apple.network", category: "connection", message: message
            ), message)
        }
    }

    func testPreservesOtherServicesSubsystemsAndCategories() {
        XCTAssertFalse(OSLogReader.isSelfGeneratedNoise(
            subsystem: "com.apple.xpc", category: "connection",
            message: "activating connection: name=com.apple.OtherService"
        ))
        XCTAssertFalse(OSLogReader.isSelfGeneratedNoise(
            subsystem: "dev.jasonpearson.automobile", category: "connection", message: "request to 127.0.0.1"
        ))
        XCTAssertFalse(OSLogReader.isSelfGeneratedNoise(
            subsystem: "com.apple.network", category: "resolver", message: "request to 127.0.0.1 on lo0"
        ))
    }
}
