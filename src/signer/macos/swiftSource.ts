export const SECURE_ENCLAVE_SWIFT_SOURCE = String.raw`import Foundation
import Security
import CryptoKit

struct RawDigest: Digest {
    static var byteCount: Int { 32 }
    let bytes: [UInt8]

    init(_ bytes: [UInt8]) {
        self.bytes = bytes
    }

    func makeIterator() -> Array<UInt8>.Iterator {
        bytes.makeIterator()
    }

    var description: String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try bytes.withUnsafeBytes { try body($0) }
    }
}

func printJson(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object) else {
        fputs("{\"ok\":false,\"error\":{\"code\":\"SWIFT_JSON_ERROR\",\"message\":\"Invalid JSON object\"}}\n", stderr)
        return
    }

    do {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        if let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    } catch {
        fputs("{\"ok\":false,\"error\":{\"code\":\"SWIFT_JSON_ERROR\",\"message\":\"Failed to encode JSON\"}}\n", stderr)
    }
}

func fail(_ code: String, _ message: String, _ details: [String: Any]? = nil) -> Never {
    var body: [String: Any] = [
        "ok": false,
        "error": [
            "code": code,
            "message": message,
        ],
    ]

    if let details {
        body["details"] = details
    }

    printJson(body)
    exit(1)
}

func parseArgs(_ args: [String]) -> (command: String, options: [String: String], flags: Set<String>) {
    guard let command = args.first else {
        fail("INVALID_ARGUMENTS", "Missing command")
    }

    var options: [String: String] = [:]
    var flags: Set<String> = []

    var index = 1
    while index < args.count {
        let arg = args[index]
        if arg.hasPrefix("--") {
            if index + 1 < args.count && !args[index + 1].hasPrefix("--") {
                options[arg] = args[index + 1]
                index += 2
                continue
            }
            flags.insert(arg)
            index += 1
            continue
        }
        index += 1
    }

    return (command, options, flags)
}

func dataFromHex(_ hex: String) -> Data? {
    let normalized = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
    if normalized.count % 2 != 0 { return nil }

    var data = Data(capacity: normalized.count / 2)
    var index = normalized.startIndex
    while index < normalized.endIndex {
        let next = normalized.index(index, offsetBy: 2)
        let byteString = normalized[index..<next]
        guard let byte = UInt8(byteString, radix: 16) else { return nil }
        data.append(byte)
        index = next
    }
    return data
}

func hexFromData(_ data: Data) -> String {
    return "0x" + data.map { String(format: "%02x", $0) }.joined()
}

func keyFromHandle(_ handle: String) throws -> SecureEnclave.P256.Signing.PrivateKey {
    guard let data = Data(base64Encoded: handle) else {
        throw NSError(domain: "agent-wallet", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid key handle encoding"]) 
    }

    do {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
    } catch {
        throw NSError(domain: "agent-wallet", code: -2, userInfo: [NSLocalizedDescriptionKey: "Key not found for provided handle"])
    }
}

func createKey() {
    let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, nil)!

    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: nil)
        let pub = Data([0x04]) + key.publicKey.rawRepresentation

        printJson([
            "ok": true,
            "publicKey": hexFromData(pub),
            "handle": key.dataRepresentation.base64EncodedString(),
        ])
    } catch {
        let message = (error as NSError).localizedDescription
        fail("KEY_CREATION_FAILED", "Unable to create Secure Enclave key: \(message)")
    }
}

func getPublicKey(handle: String) {
    do {
        let key = try keyFromHandle(handle)
        let pub = Data([0x04]) + key.publicKey.rawRepresentation
        printJson([
            "ok": true,
            "publicKey": hexFromData(pub),
        ])
    } catch {
        fail("KEY_NOT_FOUND", "No Secure Enclave key found for provided handle")
    }
}

func sign(handle: String, payloadHex: String, hashMode: String) {
    guard let payload = dataFromHex(payloadHex) else {
        fail("INVALID_PAYLOAD", "Payload must be valid hex")
    }

    do {
        let key = try keyFromHandle(handle)

        let signature: P256.Signing.ECDSASignature
        switch hashMode {
        case "sha256":
            signature = try key.signature(for: payload)
        case "none":
            if payload.count != RawDigest.byteCount {
                fail("INVALID_DIGEST_LENGTH", "Digest payload must be exactly 32 bytes when --hash none is used")
            }
            signature = try key.signature(for: RawDigest(Array(payload)))
        default:
            fail("INVALID_HASH_MODE", "Unsupported hash mode \(hashMode)")
        }

        printJson([
            "ok": true,
            "signature": hexFromData(signature.rawRepresentation),
        ])
    } catch {
        let message = (error as NSError).localizedDescription
        fail("SIGNING_FAILED", "Secure Enclave signing failed: \(message)")
    }
}

func info(handle: String?) {
    guard let handle else {
        printJson([
            "ok": true,
            "exists": false,
            "backend": "secure-enclave",
            "curve": "p256",
        ])
        return
    }

    do {
        _ = try keyFromHandle(handle)
        printJson([
            "ok": true,
            "exists": true,
            "backend": "secure-enclave",
            "curve": "p256",
        ])
    } catch {
        printJson([
            "ok": true,
            "exists": false,
            "backend": "secure-enclave",
            "curve": "p256",
        ])
    }
}

let parsed = parseArgs(Array(CommandLine.arguments.dropFirst()))
let command = parsed.command
let options = parsed.options

switch command {
case "create":
    createKey()
case "pubkey":
    guard let handle = options["--handle"] else {
        fail("INVALID_ARGUMENTS", "Missing --handle")
    }
    getPublicKey(handle: handle)
case "sign":
    guard let handle = options["--handle"] else {
        fail("INVALID_ARGUMENTS", "Missing --handle")
    }
    guard let payloadHex = options["--payload-hex"] else {
        fail("INVALID_ARGUMENTS", "Missing --payload-hex")
    }
    let hashMode = options["--hash"] ?? "sha256"
    sign(handle: handle, payloadHex: payloadHex, hashMode: hashMode)
case "info":
    info(handle: options["--handle"])
default:
    fail("INVALID_ARGUMENTS", "Unknown command \(command)")
}
`
