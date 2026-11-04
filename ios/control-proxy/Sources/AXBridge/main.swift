import AXBridgeCore
import Foundation

#if os(macOS)
    let executor = AXBridgeExecutor()
#endif

while let line = readLine(strippingNewline: true) {
    let response = AXBridgeProtocol.response(for: line) { request in
        #if os(macOS)
            executor.execute(request)
        #else
            .failure(AXBridgeError(code: "unsupported_platform", message: "AXBridge requires macOS."))
        #endif
    }
    do {
        // FileHandle writes directly to the descriptor: each response is flushed without stdio buffering.
        try FileHandle.standardOutput.write(contentsOf: Data(response.encodedLine().utf8))
    } catch {
        // A broken output pipe cannot carry another response; keep diagnostics off the protocol stream.
        FileHandle.standardError
            .write(Data("AXBridge could not write a response: \(error.localizedDescription)\n".utf8))
        break
    }
}
