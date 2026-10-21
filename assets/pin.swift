// dsh-mac-tools — "pin to screen" helper.
//
// A tiny AppKit process that shows one captured PNG as an always-on-top,
// borderless floating window the operator can drag, zoom, annotate in place,
// copy, save, fade or close. The plugin compiles this file once with `swiftc`
// (see src/pin.js) and starts one process per pinned image.
//
// Usage:
//
//     pin <image-path> <save-directory> [<x> <y> <w> <h>] [<edit-socket> <pin-id>]
//
// Mouse / keys:
//   - drag                  move the pinned image
//   - scroll                zoom about the pointer (0.2x … 4x)
//   - double click          enter / leave in-place annotation mode
//   - right click           copy / save / annotate / undo / clear / close
//   - A                     toggle annotation mode
//   - 1..5                  pen / arrow / rect / ellipse / highlighter
//   - Esc                   leave annotation mode, or close the pin
//   - ⌘Z                    undo the last stroke, ⌘C copy (with annotations)
//
// The helper exits when the window closes, and when the harness process that
// started it disappears (checked every 5 s).

import AppKit
import Carbon
import Foundation

func fail(_ message: String) -> Never {
    print("ERROR \(message)")
    fflush(stdout)
    exit(2)
}

// MARK: - Arguments

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { fail("args") }
let imagePath = arguments[1]
let saveDirectory = arguments[2]
let editSocketPath = arguments.count >= 9 ? arguments[7] : ""
let pinIdentifier = arguments.count >= 9 ? arguments[8] : ""

var placement: NSRect?
if arguments.count >= 7,
   let rx = Double(arguments[3]),
   let ry = Double(arguments[4]),
   let rw = Double(arguments[5]),
   let rh = Double(arguments[6]),
   rw >= 40, rh >= 30 {
    let mainHeight = NSScreen.screens.first?.frame.height ?? 0
    placement = NSRect(x: rx, y: mainHeight - ry - rh, width: rw, height: rh)
}

guard let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
      let sourceImage = NSImage(data: imageData) else {
    fail("image")
}
let bitmap = NSBitmapImageRep(data: imageData)
let pixelWidth = CGFloat(bitmap?.pixelsWide ?? Int(sourceImage.size.width))
let pixelHeight = CGFloat(bitmap?.pixelsHigh ?? Int(sourceImage.size.height))

// MARK: - Helpers

/// Send one trigger line to the plugin. Used only by the "edit in panel" menu.
func sendSocketLine(path: String, line: String) {
    if path.isEmpty { return }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
        NSSound.beep()
        return
    }
    defer { close(descriptor) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < capacity else { return }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { chars in
            _ = strncpy(chars, path, capacity - 1)
        }
    }
    let connected = withUnsafePointer(to: &address) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
            connect(descriptor, socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if connected != 0 {
        NSSound.beep()
        return
    }
    _ = line.withCString { request in
        write(descriptor, request, strlen(request))
    }
}

func sendEditInPanelRequest() {
    if editSocketPath.isEmpty || pinIdentifier.isEmpty { return }
    sendSocketLine(path: editSocketPath, line: "edit \(pinIdentifier)\n")
}

func normalizedRect(_ a: NSPoint, _ b: NSPoint) -> NSRect {
    NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
}

// MARK: - Annotation model

enum AnnotationTool: Int, CaseIterable {
    case pen = 0
    case arrow = 1
    case rect = 2
    case ellipse = 3
    case highlight = 4

    /// Compact label so the whole toolbar fits a small pinned image.
    var title: String {
        switch self {
        case .pen: return "✐ 笔"
        case .arrow: return "↗ 箭"
        case .rect: return "▭ 矩"
        case .ellipse: return "◯ 椭"
        case .highlight: return "▆ 亮"
        }
    }

    var fullTitle: String {
        switch self {
        case .pen: return "画笔 Pen"
        case .arrow: return "箭头 Arrow"
        case .rect: return "矩形 Rectangle"
        case .ellipse: return "椭圆 Ellipse"
        case .highlight: return "高亮 Highlighter"
        }
    }
}

struct Annotation {
    var tool: AnnotationTool
    var color: NSColor
    var width: CGFloat
    var points: [NSPoint]
}

let palette: [(String, NSColor)] = [
    ("红", .systemRed),
    ("黄", .systemYellow),
    ("蓝", .systemBlue),
    ("绿", .systemGreen),
    ("白", .white),
    ("黑", .black),
]

// MARK: - Canvas

final class AnnotationCanvas: NSView {
    let image: NSImage
    let imageData: Data
    let imagePixelWidth: CGFloat
    let imagePixelHeight: CGFloat
    let saveDirectory: String
    weak var panel: NSPanel?
    var toolbar: AnnotationToolbar?

    var annotations: [Annotation] = []
    var current: Annotation?
    var tool: AnnotationTool = .pen
    var color: NSColor = .systemRed
    var lineWidth: CGFloat = 4
    var annotating = false
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint?
    private var zoom: CGFloat = 1.0

    init(frame: NSRect, image: NSImage, imageData: Data, pixelWidth: CGFloat, pixelHeight: CGFloat, saveDirectory: String) {
        self.image = image
        self.imageData = imageData
        self.imagePixelWidth = max(1, pixelWidth)
        self.imagePixelHeight = max(1, pixelHeight)
        self.saveDirectory = saveDirectory
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { false }

    /// The rectangle the image occupies inside the view (aspect fit).
    func imageRect() -> NSRect {
        let bounds = self.bounds
        guard image.size.width > 0, image.size.height > 0 else { return bounds }
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let width = image.size.width * scale
        let height = image.size.height * scale
        return NSRect(x: bounds.midX - width / 2, y: bounds.midY - height / 2, width: width, height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        image.draw(in: imageRect(), from: NSRect(origin: .zero, size: image.size), operation: .sourceOver, fraction: 1.0)
        for annotation in annotations {
            drawAnnotation(annotation)
        }
        if let current = current {
            drawAnnotation(current)
        }
    }

    /// Draw one annotation in the current graphics context (view coordinates).
    func drawAnnotation(_ annotation: Annotation) {
        guard let first = annotation.points.first else { return }
        let isHighlight = annotation.tool == .highlight
        let strokeColor = isHighlight ? annotation.color.withAlphaComponent(0.35) : annotation.color
        let width = isHighlight ? annotation.width * 4 : annotation.width
        strokeColor.setStroke()
        switch annotation.tool {
        case .pen, .highlight:
            if annotation.points.count == 1 {
                let dot = NSBezierPath(ovalIn: NSRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width))
                strokeColor.setFill()
                dot.fill()
                return
            }
            let path = NSBezierPath()
            path.lineWidth = width
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            path.move(to: annotation.points[0])
            for point in annotation.points.dropFirst() {
                path.line(to: point)
            }
            path.stroke()
        case .rect, .ellipse:
            guard let last = annotation.points.last else { return }
            let rect = normalizedRect(first, last)
            let path: NSBezierPath
            if annotation.tool == .rect {
                path = NSBezierPath(rect: rect)
            } else {
                path = NSBezierPath(ovalIn: rect)
            }
            path.lineWidth = width
            path.stroke()
        case .arrow:
            guard let last = annotation.points.last else { return }
            let path = NSBezierPath()
            path.lineWidth = width
            path.lineCapStyle = .round
            path.move(to: first)
            path.line(to: last)
            path.stroke()
            let angle = atan2(last.y - first.y, last.x - first.x)
            let headLength = max(10, width * 3.5)
            let spread = CGFloat.pi / 7
            let head = NSBezierPath()
            head.lineWidth = width
            head.lineCapStyle = .round
            head.move(to: last)
            head.line(to: NSPoint(x: last.x - headLength * cos(angle - spread), y: last.y - headLength * sin(angle - spread)))
            head.move(to: last)
            head.line(to: NSPoint(x: last.x - headLength * cos(angle + spread), y: last.y - headLength * sin(angle + spread)))
            head.stroke()
        }
    }

    /// Flatten the image and annotations into PNG bytes at the original pixel size.
    func compositePNGData() -> Data? {
        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(imagePixelWidth),
            pixelsHigh: Int(imagePixelHeight),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        guard let context = NSGraphicsContext(bitmapImageRep: representation) else { return nil }
        let drawingRect = imageRect()
        let scaleX = imagePixelWidth / max(1, drawingRect.width)
        let scaleY = imagePixelHeight / max(1, drawingRect.height)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let cg = context.cgContext
        cg.translateBy(x: -drawingRect.origin.x * scaleX, y: -drawingRect.origin.y * scaleY)
        cg.scaleBy(x: scaleX, y: scaleY)
        image.draw(in: drawingRect, from: NSRect(origin: .zero, size: image.size), operation: .sourceOver, fraction: 1.0)
        for annotation in annotations {
            drawAnnotation(annotation)
        }
        NSGraphicsContext.restoreGraphicsState()
        return representation.representation(using: .png, properties: [:])
    }

    func copyToPasteboard() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if let data = compositePNGData() ?? imageData as Data? {
            pasteboard.setData(data, forType: .png)
            NSSound(named: "Glass")?.play()
        }
    }

    func saveToDisk() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let file = "pin-\(formatter.string(from: Date())).png"
        let directory = URL(fileURLWithPath: saveDirectory, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(file)
        do {
            if let data = compositePNGData() ?? imageData as Data? {
                try data.write(to: destination)
                NSSound(named: "Glass")?.play()
            }
        } catch {
            NSSound.beep()
        }
    }

    // MARK: annotation mode

    func setAnnotating(_ enabled: Bool) {
        annotating = enabled
        toolbar?.isHidden = !enabled
        if enabled {
            window?.makeKey()
            window?.makeFirstResponder(self)
        }
        needsDisplay = true
    }

    func selectTool(_ tool: AnnotationTool) {
        self.tool = tool
        toolbar?.refreshState()
    }

    func undo() {
        if !annotations.isEmpty {
            annotations.removeLast()
            needsDisplay = true
        }
    }

    func clearAnnotations() {
        annotations.removeAll()
        needsDisplay = true
    }

    // MARK: mouse / keyboard

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 && !annotating {
            setAnnotating(true)
            return
        }
        if annotating {
            let point = convert(event.locationInWindow, from: nil)
            guard imageRect().contains(point) else { return }
            current = Annotation(tool: tool, color: color, width: lineWidth, points: [point])
            needsDisplay = true
            return
        }
        window?.makeKey()
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = window?.frame.origin
    }

    override func mouseDragged(with event: NSEvent) {
        if annotating {
            guard var annotation = current else { return }
            let point = convert(event.locationInWindow, from: nil)
            guard imageRect().contains(point) || annotation.points.count > 1 else { return }
            if annotation.tool == .pen || annotation.tool == .highlight {
                annotation.points.append(point)
            } else {
                if annotation.points.count == 1 {
                    annotation.points.append(point)
                } else {
                    annotation.points[annotation.points.count - 1] = point
                }
            }
            current = annotation
            needsDisplay = true
            return
        }
        guard let startMouse = dragStartMouse, let startOrigin = dragStartOrigin, let window = window else { return }
        let current = NSEvent.mouseLocation
        window.setFrameOrigin(NSPoint(x: startOrigin.x + (current.x - startMouse.x), y: startOrigin.y + (current.y - startMouse.y)))
    }

    override func mouseUp(with event: NSEvent) {
        if annotating, let annotation = current {
            if annotation.points.count > 1 || annotation.tool == .pen || annotation.tool == .highlight {
                annotations.append(annotation)
            }
            current = nil
            needsDisplay = true
            return
        }
        dragStartMouse = nil
        dragStartOrigin = nil
    }

    override func scrollWheel(with event: NSEvent) {
        guard !annotating, let window = window else { return }
        let step = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY / 120.0 : event.scrollingDeltaY / 6.0
        guard step != 0 else { return }
        let next = min(4.0, max(0.2, zoom * (1.0 + step * 0.12)))
        guard next != zoom else { return }
        let oldFrame = window.frame
        let ratio = next / zoom
        let width = max(40.0, oldFrame.width * ratio)
        let height = max(30.0, oldFrame.height * ratio)
        let pointer = NSEvent.mouseLocation
        let relativeX = (pointer.x - oldFrame.origin.x) / max(1, oldFrame.width)
        let relativeY = (pointer.y - oldFrame.origin.y) / max(1, oldFrame.height)
        zoom = next
        window.setFrame(NSRect(x: pointer.x - width * relativeX, y: pointer.y - height * relativeY, width: width, height: height), display: true)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Esc
            if annotating {
                setAnnotating(false)
            } else {
                NSApp.terminate(nil)
            }
            return
        }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "z" {
            undo()
            return
        }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "c" {
            copyToPasteboard()
            return
        }
        if let characters = event.charactersIgnoringModifiers {
            if let number = Int(characters), number >= 1, number <= 5, let tool = AnnotationTool(rawValue: number - 1) {
                selectTool(tool)
                return
            }
            if characters.lowercased() == "a" {
                setAnnotating(!annotating)
                return
            }
        }
        super.keyDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()

        let annotateTitle = annotating ? "完成标注  Finish annotating" : "标注图片  Annotate here"
        let annotateItem = NSMenuItem(title: annotateTitle, action: #selector(toggleAnnotating), keyEquivalent: "")
        annotateItem.target = self
        menu.addItem(annotateItem)

        let undoItem = NSMenuItem(title: "撤销标注  Undo stroke", action: #selector(undoAction), keyEquivalent: "")
        undoItem.target = self
        menu.addItem(undoItem)

        let clearItem = NSMenuItem(title: "清除标注  Clear annotations", action: #selector(clearAction), keyEquivalent: "")
        clearItem.target = self
        menu.addItem(clearItem)

        menu.addItem(NSMenuItem.separator())

        let copyItem = NSMenuItem(title: "复制图片  Copy image", action: #selector(copyAction), keyEquivalent: "")
        copyItem.target = self
        menu.addItem(copyItem)

        let saveItem = NSMenuItem(title: "保存到截图目录  Save to folder", action: #selector(saveAction), keyEquivalent: "")
        saveItem.target = self
        menu.addItem(saveItem)

        let opacityItem = NSMenuItem(title: "不透明度  Opacity", action: nil, keyEquivalent: "")
        let opacityMenu = NSMenu()
        for (index, amount) in [1.0, 0.8, 0.6, 0.4].enumerated() {
            let entry = NSMenuItem(title: "\(Int(amount * 100))%", action: #selector(setOpacity(_:)), keyEquivalent: "")
            entry.target = self
            entry.tag = index
            opacityMenu.addItem(entry)
        }
        opacityItem.submenu = opacityMenu
        menu.addItem(opacityItem)

        menu.addItem(NSMenuItem.separator())
        let panelEditItem = NSMenuItem(title: "在面板中编辑  Edit in panel…", action: #selector(editInPanel), keyEquivalent: "")
        panelEditItem.target = self
        menu.addItem(panelEditItem)

        let closeItem = NSMenuItem(title: "关闭贴图  Close pin", action: #selector(closePin), keyEquivalent: "")
        closeItem.target = self
        menu.addItem(closeItem)

        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func toggleAnnotating() {
        setAnnotating(!annotating)
    }

    @objc private func undoAction() {
        undo()
    }

    @objc private func clearAction() {
        clearAnnotations()
    }

    @objc private func copyAction() {
        copyToPasteboard()
    }

    @objc private func saveAction() {
        saveToDisk()
    }

    @objc private func setOpacity(_ sender: NSMenuItem) {
        let amounts: [CGFloat] = [1.0, 0.8, 0.6, 0.4]
        window?.alphaValue = amounts[max(0, min(amounts.count - 1, sender.tag))]
    }

    @objc private func editInPanel() {
        sendEditInPanelRequest()
    }

    @objc private func closePin() {
        NSApp.terminate(nil)
    }
}

// MARK: - In-window toolbar

final class AnnotationToolbar: NSView {
    weak var canvas: AnnotationCanvas?
    private let stack = NSStackView()
    private var toolButtons: [AnnotationTool: NSButton] = [:]
    private var colorPopup: NSPopUpButton?

    init(canvas: AnnotationCanvas) {
        self.canvas = canvas
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.82).cgColor
        layer?.cornerRadius = 8
        buildControls()
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var isFlipped: Bool { false }

    private func buildControls() {
        stack.orientation = .horizontal
        stack.spacing = 6
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        for tool in AnnotationTool.allCases {
            let button = NSButton(title: tool.title, target: self, action: #selector(selectTool(_:)))
            button.setButtonType(.toggle)
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = NSFont.systemFont(ofSize: 11)
            button.toolTip = tool.fullTitle
            button.tag = tool.rawValue
            button.state = tool == .pen ? .on : .off
            toolButtons[tool] = button
            stack.addArrangedSubview(button)
        }

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: palette.map { $0.0 })
        popup.target = self
        popup.action = #selector(selectColor(_:))
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        colorPopup = popup
        stack.addArrangedSubview(popup)

        let widthPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        widthPopup.addItems(withTitles: ["细", "中", "粗"])
        widthPopup.selectItem(at: 1)
        widthPopup.target = self
        widthPopup.action = #selector(selectWidth(_:))
        widthPopup.controlSize = .small
        widthPopup.font = NSFont.systemFont(ofSize: 11)
        stack.addArrangedSubview(widthPopup)

        let undoButton = NSButton(title: "↶", target: self, action: #selector(undoAction))
        undoButton.toolTip = "撤销上一步 Undo"
        undoButton.bezelStyle = .rounded
        undoButton.controlSize = .small
        undoButton.font = NSFont.systemFont(ofSize: 11)
        stack.addArrangedSubview(undoButton)

        let clearButton = NSButton(title: "⌫", target: self, action: #selector(clearAction))
        clearButton.toolTip = "清除全部标注 Clear"
        clearButton.bezelStyle = .rounded
        clearButton.controlSize = .small
        clearButton.font = NSFont.systemFont(ofSize: 11)
        stack.addArrangedSubview(clearButton)

        let doneButton = NSButton(title: "完成", target: self, action: #selector(doneAction))
        doneButton.toolTip = "完成标注 Finish"
        doneButton.bezelStyle = .rounded
        doneButton.controlSize = .small
        doneButton.font = NSFont.systemFont(ofSize: 11)
        stack.addArrangedSubview(doneButton)
    }

    func refreshState() {
        guard let canvas = canvas else { return }
        for (tool, button) in toolButtons {
            button.state = tool == canvas.tool ? .on : .off
        }
    }

    @objc private func selectTool(_ sender: NSButton) {
        guard let tool = AnnotationTool(rawValue: sender.tag) else { return }
        canvas?.selectTool(tool)
    }

    @objc private func selectColor(_ sender: NSPopUpButton) {
        let index = max(0, min(palette.count - 1, sender.indexOfSelectedItem))
        canvas?.color = palette[index].1
    }

    @objc private func selectWidth(_ sender: NSPopUpButton) {
        let widths: [CGFloat] = [3, 6, 10]
        let index = max(0, min(widths.count - 1, sender.indexOfSelectedItem))
        canvas?.lineWidth = widths[index]
    }

    @objc private func undoAction() {
        canvas?.undo()
    }

    @objc private func clearAction() {
        canvas?.clearAnnotations()
    }

    @objc private func doneAction() {
        canvas?.setAnnotating(false)
    }
}

// MARK: - Window

final class PinPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

let screen = NSScreen.main ?? NSScreen.screens.first
let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
let mouse = NSEvent.mouseLocation
let frame: NSRect
if let placement = placement {
    frame = placement
} else {
    let fit = min(1.0, min((visible.width * 0.75) / sourceImage.size.width, (visible.height * 0.75) / sourceImage.size.height))
    let width = max(40.0, sourceImage.size.width * fit)
    let height = max(30.0, sourceImage.size.height * fit)
    let originX = min(max(visible.minX, mouse.x - width / 2), visible.maxX - width)
    let originY = min(max(visible.minY, mouse.y - height / 2), visible.maxY - height)
    frame = NSRect(x: originX, y: originY, width: width, height: height)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let panel = PinPanel(
    contentRect: frame,
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
let canvas = AnnotationCanvas(
    frame: NSRect(x: 0, y: 0, width: frame.width, height: frame.height),
    image: sourceImage,
    imageData: imageData,
    pixelWidth: pixelWidth,
    pixelHeight: pixelHeight,
    saveDirectory: saveDirectory
)
canvas.panel = panel
let toolbar = AnnotationToolbar(canvas: canvas)
toolbar.isHidden = true
canvas.toolbar = toolbar
canvas.addSubview(toolbar)
let toolbarHeight: CGFloat = 34
toolbar.frame = NSRect(x: 6, y: max(0, frame.height - toolbarHeight - 6), width: max(120, frame.width - 12), height: toolbarHeight)
toolbar.autoresizingMask = [.width, .minYMargin]

panel.contentView = canvas
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = true
panel.level = .floating
panel.isFloatingPanel = true
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.orderFrontRegardless()
panel.makeKey()

// Exit when the harness process goes away so pins never outlive their host.
Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
    if kill(getppid(), 0) != 0 {
        exit(0)
    }
}

print("READY")
fflush(stdout)
application.run()
