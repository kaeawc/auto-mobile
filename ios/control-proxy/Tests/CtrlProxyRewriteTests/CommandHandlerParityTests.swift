import Foundation
import XCTest

/// Differential parity for the Phase-6 `CommandHandler` router, driven through the
/// per-module drivers (`ReferenceCommandDriver` imports `CtrlProxy`,
/// `RewriteCommandDriver` imports `CtrlProxyRewrite`; this file imports neither).
///
/// Two layers (STATUS §9.6):
/// - **Routing parity**: the same request produces a byte-identical response envelope from
///   both handlers, after stripping the fields that are legitimately non-deterministic
///   (`Date()`-stamped `timestamp`/`updatedAt`, wall-clock `totalTimeMs`, timing-dependent
///   `perfTiming`, and the per-process-epoch `frameContext`). This pins the dispatch table:
///   every command routes to a handler producing the right response type + success/error +
///   command-specific fields.
/// - **Integration perfTiming parity**: a real request driven through
///   `WebSocketServer.handleMessage` (which brackets the command in `perf.withScope`) emits
///   the same `perfTiming` name-tree on the wire from both modules — proving the `withScope`
///   wiring actually accumulates timings, which the Phase-5 engine parity cannot (§8).
final class CommandHandlerParityTests: XCTestCase {
    private static let volatileKeys: Set<String> = [
        "timestamp", "totalTimeMs", "perfTiming", "frameContext", "updatedAt",
    ]

    /// Parse to a JSON object with the volatile keys recursively removed.
    private func normalized(_ data: Data, file: StaticString = #filePath, line: UInt = #line) -> NSObject? {
        guard let object = try? JSONSerialization.jsonObject(with: data) else {
            XCTFail("not JSON: \(String(decoding: data, as: UTF8.self))", file: file, line: line)
            return nil
        }
        return strip(object) as? NSObject
    }

    private func strip(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (key, nested) in dict where !Self.volatileKeys.contains(key) {
                out[key] = strip(nested)
            }
            return out
        }
        if let array = value as? [Any] {
            return array.map { strip($0) }
        }
        return value
    }

    // MARK: - Routing parity

    func testRoutingParityAcrossCommands() async {
        let requests: [String] = [
            // Gestures
            #"{"type":"request_tap_coordinates","requestId":"r","x":10,"y":20}"#,
            #"{"type":"request_swipe","requestId":"r","x1":1,"y1":2,"x2":3,"y2":4}"#,
            #"{"type":"request_two_finger_swipe","requestId":"r","x1":1,"y1":2,"x2":3,"y2":4}"#,
            #"{"type":"request_multi_finger_swipe","requestId":"r","x1":1,"y1":2,"x2":3,"y2":4,"fingerCount":3}"#,
            #"{"type":"request_drag","requestId":"r","x1":1,"y1":2,"x2":3,"y2":4}"#,
            #"{"type":"request_pinch","requestId":"r","centerX":5,"centerY":5,"distanceStart":10,"distanceEnd":20}"#,
            // Text input
            #"{"type":"request_set_text","requestId":"r","text":"hi"}"#,
            #"{"type":"request_set_text","requestId":"r","text":"hi","resourceId":"field"}"#,
            #"{"type":"request_append_text","requestId":"r","text":"hi"}"#,
            #"{"type":"request_clear_text","requestId":"r"}"#,
            #"{"type":"request_ime_action","requestId":"r","action":"done"}"#,
            #"{"type":"request_select_all","requestId":"r"}"#,
            #"{"type":"request_keyboard","requestId":"r","action":"detect"}"#,
            #"{"type":"request_keyboard","requestId":"r","action":"open"}"#,
            // Buttons / navigation
            #"{"type":"request_press_button","requestId":"r","action":"home"}"#,
            #"{"type":"request_press_home","requestId":"r"}"#,
            #"{"type":"request_press_back","requestId":"r"}"#,
            #"{"type":"request_shake","requestId":"r"}"#,
            #"{"type":"request_recent_apps","requestId":"r"}"#,
            // Actions / launch
            #"{"type":"request_action","requestId":"r","action":"click","resourceId":"x"}"#,
            #"{"type":"request_activate_accessibility_link","requestId":"r","text":"link","occurrence":0}"#,
            #"{"type":"request_launch_app","requestId":"r","bundleId":"com.x"}"#,
            #"{"type":"request_reset_permissions","requestId":"r","bundleId":"com.x","permissions":[]}"#,
            // Device / clipboard / rotate
            #"{"type":"request_rotate","requestId":"r","orientation":"landscape"}"#,
            #"{"type":"request_rotate","requestId":"r","orientation":"bogus"}"#,
            #"{"type":"request_clipboard","requestId":"r","action":"get"}"#,
            #"{"type":"request_screenshot","requestId":"r"}"#,
            // Hierarchy
            #"{"type":"request_hierarchy","requestId":"r"}"#,
            #"{"type":"set_hierarchy_poll_interval","requestId":"r","intervalMs":0}"#,
            // Accessibility
            #"{"type":"get_current_focus","requestId":"r"}"#,
            #"{"type":"get_traversal_order","requestId":"r"}"#,
            #"{"type":"add_highlight","requestId":"r"}"#,
            // Storage (no inspector → unavailable)
            #"{"type":"list_preference_files","requestId":"r"}"#,
            #"{"type":"get_preferences","requestId":"r"}"#,
            #"{"type":"get_preference","requestId":"r","key":"k"}"#,
            #"{"type":"set_preference","requestId":"r","key":"k","valueType":"string"}"#,
            #"{"type":"remove_preference","requestId":"r","key":"k"}"#,
            #"{"type":"clear_preferences","requestId":"r"}"#,
            // Network mocking (no client → ok:false)
            #"{"type":"set_network_mock_rules","requestId":"r","rules":[]}"#,
            #"{"type":"set_network_fault_rules","requestId":"r","rules":[]}"#,
            #"{"type":"set_network_error_simulation","requestId":"r","enabled":true}"#,
            // Database (no client → unavailable)
            #"{"type":"execute_sql","requestId":"r","appId":"a","databasePath":"/db","query":"SELECT 1"}"#,
            #"{"type":"list_databases","requestId":"r","appId":"a"}"#,
            #"{"type":"storage_capabilities","requestId":"r","appId":"a"}"#,
            #"{"type":"list_tables","requestId":"r","appId":"a","databasePath":"/db"}"#,
            #"{"type":"get_table_data","requestId":"r","appId":"a","databasePath":"/db","table":"t"}"#,
            #"{"type":"get_table_structure","requestId":"r","appId":"a","databasePath":"/db","table":"t"}"#,
        ]

        for json in requests {
            let reference = normalized(ReferenceCommandDriver.handleEncoded(json))
            let rewrite = normalized(await RewriteCommandDriver.handleEncoded(json))
            XCTAssertNotNil(rewrite, "rewrite produced no response for \(json)")
            XCTAssertEqual(reference, rewrite, "response envelope diverged for \(json)")
        }
    }

    // MARK: - Integration perfTiming parity (§8 obligation)

    func testPerfTimingEmittedOnTheWireMatches() async {
        let json = #"{"type":"request_hierarchy","requestId":"h1"}"#

        let referenceTree = ReferenceCommandDriver.perfTimingTreeThroughServer(json)
        let rewriteTree = await RewriteCommandDriver.perfTimingTreeThroughServer(json)

        // Non-empty: a missing `withScope` wire-up would leave this nil while the Phase-5
        // engine tests still pass.
        XCTAssertEqual(
            rewriteTree,
            "handleRequest:request_hierarchy[handleRequestHierarchy[extraction]]",
            "rewrite did not emit the expected perfTiming tree on the wire"
        )
        XCTAssertEqual(referenceTree, rewriteTree, "perfTiming tree diverged from the reference")
    }
}
