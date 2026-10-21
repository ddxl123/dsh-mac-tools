// dsh-mac-tools — global screenshot hotkey helper.
//
// A tiny resident AppKit/Carbon process that registers one system-wide hotkey
// (`RegisterEventHotKey`, which needs no Accessibility permission) and, when it
// fires, connects to the plugin's private Unix socket and writes one line:
//     screenshot
//
// The plugin compiles this file once with `swiftc` (see src/hotkey.js), starts
// it while the plugin row is active, and kills it on unload. Usage:
//
//     hotkey <carbon-keycode> <carbon-modifier-mask> <socket-path>
//
// The process prints `READY` on stdout once the hotkey is armed, or
// `ERROR <reason>` and exits non-zero when it cannot register. It exits by
// itself when its parent process disappears, so a crashed harness does not
// leave an orphan holding the shortcut.

import AppKit
import Carbon
import Foundation

func fail(_ message: String) -> Never {
    print("ERROR \(message)")
    fflush(stdout)
    exit(2)
}

let arguments = CommandLine.arguments
guard arguments.count >= 4,
      let keyCode = UInt32(arguments[1]),
      let modifiers = UInt32(arguments[2]) else {
    fail("args")
}
let socketPath = arguments[3]

/// Send one trigger line to the plugin's Unix socket. A failed connect means
/// the plugin is gone, so the helper exits instead of lingering.
func sendTrigger() {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    if descriptor < 0 {
        exit(0)
    }
    defer { close(descriptor) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    if socketPath.utf8.count >= capacity {
        fail("socket-path-too-long")
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { chars in
            _ = strncpy(chars, socketPath, capacity - 1)
        }
    }
    let connected = withUnsafePointer(to: &address) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
            connect(descriptor, socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if connected != 0 {
        exit(0)
    }
    _ = "screenshot\n".withCString { line in
        write(descriptor, line, strlen(line))
    }
}

var hotKeyRef: EventHotKeyRef?
var handlerRef: EventHandlerRef?

let hotKeyID = EventHotKeyID(signature: OSType(0x44534854), id: 1) // 'DSHT'
let registerStatus = RegisterEventHotKey(
    keyCode,
    modifiers,
    hotKeyID,
    GetApplicationEventTarget(),
    0,
    &hotKeyRef
)
guard registerStatus == noErr else {
    fail("register-\(registerStatus)")
}

var eventType = EventTypeSpec(
    eventClass: OSType(kEventClassKeyboard),
    eventKind: UInt32(kEventHotKeyPressed)
)
let installStatus = InstallEventHandler(
    GetApplicationEventTarget(),
    { (_, _, _) -> OSStatus in
        sendTrigger()
        return noErr
    },
    1,
    &eventType,
    nil,
    &handlerRef
)
guard installStatus == noErr else {
    fail("install-\(installStatus)")
}

// Exit when the harness process is gone: the socket owner is the parent.
let parentWatch = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
    if kill(getppid(), 0) != 0 {
        exit(0)
    }
}
parentWatch.tolerance = 1.0

for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber) { _ in
        exit(0)
    }
}

print("READY")
fflush(stdout)
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.run()
