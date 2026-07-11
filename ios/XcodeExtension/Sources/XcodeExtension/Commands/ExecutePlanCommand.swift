import Foundation

/// Pure, testable logic for the Execute Plan source-editor command.
///
/// Kept outside the `canImport(XcodeKit)` gate so it can be unit-tested without
/// the Xcode extension host (issue #3620).
enum ExecutePlanCommandLogic {
    static let notificationName = "com.automobile.execute-plan"

    /// Validate the editor buffer content that will be sent to the companion app.
    /// Returns an error when there is no runnable plan (empty/whitespace-only),
    /// otherwise `nil`.
    static func planContentError(_ content: String) -> NSError? {
        guard content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return NSError(
            domain: "AutoMobile",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey:
                "The active editor buffer is empty; open an AutoMobile plan file before running Execute Plan."]
        )
    }
}

#if canImport(XcodeKit)
    import XcodeKit

    /// Command to execute the current AutoMobile plan
    class ExecutePlanCommand: NSObject, XCSourceEditorCommand {
        func perform(
            with invocation: XCSourceEditorCommandInvocation,
            completionHandler: @escaping (Error?) -> Void
        ) {
            // The source-editor buffer does not expose the file URL (the previous
            // `buffer.contentUTI as? URL` cast was between unrelated types and
            // always failed, so this command could never run — issue #3620). Send
            // the plan *content* to the companion app instead.
            let planContent = invocation.buffer.completeBuffer
            if let error = ExecutePlanCommandLogic.planContentError(planContent) {
                completionHandler(error)
                return
            }

            DistributedNotificationCenter.default().post(
                name: NSNotification.Name(ExecutePlanCommandLogic.notificationName),
                object: planContent
            )
            print("Executing AutoMobile plan (\(planContent.count) chars)")
            completionHandler(nil)
        }
    }
#endif
