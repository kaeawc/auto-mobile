#if DEBUG && !os(watchOS)
    import Foundation
    import Network

    enum SdkHttpResponseWriter {
        static func sendResponse(
            _ connection: NWConnection, statusCode: Int, body: Data?, extraHeaders: [(String, String)] = []
        ) {
            let statusText: String
            switch statusCode {
            case 200: statusText = "OK"
            case 204: statusText = "No Content"
            case 400: statusText = "Bad Request"
            case 404: statusText = "Not Found"
            case 405: statusText = "Method Not Allowed"
            case 409: statusText = "Conflict"
            case 431: statusText = "Request Header Fields Too Large"
            case 500: statusText = "Internal Server Error"
            case 503: statusText = "Service Unavailable"
            default: statusText = "Unknown"
            }

            let bodyData = body ?? Data()
            var header = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
            header += "Content-Type: application/json\r\n"
            header += "Content-Length: \(bodyData.count)\r\n"
            header += "Connection: close\r\n"
            for (name, value) in extraHeaders {
                header += "\(name): \(value)\r\n"
            }
            header += "\r\n"

            var responseData = Data(header.utf8)
            responseData.append(bodyData)

            connection.send(content: responseData, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
#endif
