import Foundation
import AppKit
import ScreenCaptureKit
import Vision
import ApplicationServices

struct BridgeError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
struct Region {
    let x: Double, y: Double, w: Double, h: Double
    init(_ raw: Any?) throws {
        guard let d = raw as? [String: Any], let x = d["x"] as? Double, let y = d["y"] as? Double,
              let w = d["w"] as? Double, let h = d["h"] as? Double,
              x >= 0, y >= 0, w > 0, h > 0, x+w <= 1.001, y+h <= 1.001 else { throw BridgeError("窗口标记区域无效") }
        self.x=x;self.y=y;self.w=w;self.h=h
    }
    func contains(_ box: [String: Double]) -> Bool {
        let px=(box["x"] ?? 0)+(box["w"] ?? 0)/2, py=(box["y"] ?? 0)+(box["h"] ?? 0)/2
        return px >= x && px <= x+w && py >= y && py <= y+h
    }
}
func normalized(_ value: String) -> String {
    value.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters).union(.symbols).contains($0) }.map(String.init).joined()
}
func isWeChat(_ pid: pid_t) -> Bool {
    guard let id=NSRunningApplication(processIdentifier:pid)?.bundleIdentifier else { return false }
    return ["com.tencent.xinWeChat","com.tencent.WeChat"].contains(id)
}
func listedWindows() -> [[String:Any]] {
    let raw=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    return raw.compactMap { row in
        guard let pid=row[kCGWindowOwnerPID as String] as? Int32,isWeChat(pid),
              let id=row[kCGWindowNumber as String] as? Int,
              (row[kCGWindowLayer as String] as? Int ?? -1)==0,
              let dict=row[kCGWindowBounds as String] as? [String:Any],let bounds=CGRect(dictionaryRepresentation:dict as CFDictionary),bounds.width>300,bounds.height>300 else {return nil}
        return ["id":id,"pid":pid,"title":row[kCGWindowName as String] as? String ?? "微信聊天窗口","width":bounds.width,"height":bounds.height]
    }
}
struct Shot { let image:CGImage;let window:SCWindow;let lines:[[String:Any]] }
@available(macOS 14.0, *)
func shot(_ id: CGWindowID) async throws -> Shot {
    guard CGPreflightScreenCaptureAccess() else {throw BridgeError("需要屏幕录制权限，请在系统设置中为回响开启")}
    let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
    guard let window=content.windows.first(where:{$0.windowID==id}),let app=window.owningApplication,isWeChat(app.processID) else {throw BridgeError("未找到选定的微信窗口，请重新连接")}
    guard window.frame.width>=300 && window.frame.height>=300 else {throw BridgeError("微信窗口太小，请展开聊天窗口")}
    let filter=SCContentFilter(desktopIndependentWindow:window)
    let config=SCStreamConfiguration();config.width=Int(window.frame.width);config.height=Int(window.frame.height);config.showsCursor=false
    config.ignoreShadowsSingleWindow=true
    let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
    let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate
    request.recognitionLanguages=["zh-Hans","zh-Hant","en-US"];request.usesLanguageCorrection=false
    try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
    let lines=(request.results ?? []).compactMap { observation -> [String:Any]? in
        guard let text=observation.topCandidates(1).first,text.confidence>=0.45 else{return nil}
        let b=observation.boundingBox
        let rect:[String:Double]=["x":b.minX,"y":1-b.maxY,"w":b.width,"h":b.height]
        return ["text":text.string,"confidence":text.confidence,"box":rect,"outgoing":greenBackground(image,rect)]
    }
    return Shot(image:image,window:window,lines:lines)
}
func greenBackground(_ image:CGImage,_ b:[String:Double]) -> Bool {
    let width=image.width,height=image.height
    let pixel=UnsafeMutableRawPointer.allocate(byteCount:4,alignment:4)
    defer {pixel.deallocate()}
    guard let context=CGContext(data:pixel,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{return false}
    let x=(b["x"] ?? 0)*Double(width),y=(b["y"] ?? 0)*Double(height),w=(b["w"] ?? 0)*Double(width),h=(b["h"] ?? 0)*Double(height)
    let points=[CGPoint(x:x-3,y:y+h/2),CGPoint(x:x+w+3,y:y+h/2),CGPoint(x:x+w/2,y:y-2),CGPoint(x:x+w/2,y:y+h+2)]
    var matches=0
    for p in points {
        guard p.x>=0,p.y>=0,p.x<Double(width),p.y<Double(height),let cropped=image.cropping(to:CGRect(x:p.x,y:p.y,width:1,height:1)) else{continue}
        context.draw(cropped,in:CGRect(x:0,y:0,width:1,height:1))
        let r=Double(pixel.load(fromByteOffset:0,as:UInt8.self)),g=Double(pixel.load(fromByteOffset:1,as:UInt8.self)),b=Double(pixel.load(fromByteOffset:2,as:UInt8.self))
        if g-r>12 && g-b>10 && g>55 {matches+=1}
    }
    return matches>=2
}
func titleMatches(_ lines:[[String:Any]],_ expected:String,_ region:Region)->Bool {
    let target=expected.precomposedStringWithCompatibilityMapping.trimmingCharacters(in:.whitespacesAndNewlines);guard !target.isEmpty else{return false}
    return lines.contains { line in
        guard let box=line["box"] as? [String:Double],region.contains(box),let text=line["text"] as? String else{return false}
        if let confidence=line["confidence"] as? Double,confidence<0.85{return false}
        let seen=text.precomposedStringWithCompatibilityMapping.trimmingCharacters(in:.whitespacesAndNewlines)
        let stripped=seen.replacingOccurrences(of:"\\s*\\(\\d+\\)\\s*$",with:"",options:.regularExpression)
        return seen==target || stripped==target
    }
}
func existingDraft(_ lines:[[String:Any]],_ region:Region)->Bool {
    lines.contains { line in
        guard let box=line["box"] as? [String:Double],region.contains(box),let text=line["text"] as? String else{return false}
        return !["发送","发送S","Send","输入消息","输入文字"].contains(text.trimmingCharacters(in:.whitespacesAndNewlines))
    }
}
func regionText(_ lines:[[String:Any]],_ region:Region)->[String] {
    lines.filter { line in
        guard let box=line["box"] as? [String:Double] else{return false}
        return region.contains(box)
    }.sorted { a,b in
        let x=a["box"] as! [String:Double],y=b["box"] as! [String:Double]
        return x["y"]! == y["y"]! ? x["x"]! < y["x"]! : x["y"]! < y["y"]!
    }.compactMap{$0["text"] as? String}.map(normalized)
}
func raiseWindow(_ target:SCWindow) throws {
    guard AXIsProcessTrusted() else{throw BridgeError("需要辅助功能权限，请在系统设置中为回响开启")}
    guard let pid=target.owningApplication?.processID,isWeChat(pid),let running=NSRunningApplication(processIdentifier:pid) else{throw BridgeError("微信进程不可用")}
    let app=AXUIElementCreateApplication(pid)
    var raw:CFTypeRef?
    guard AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement] else {throw BridgeError("无法定位微信窗口，请检查辅助功能授权")}
    var chosen:AXUIElement?
    for window in windows {
        var p:CFTypeRef?,s:CFTypeRef?;AXUIElementCopyAttributeValue(window,kAXPositionAttribute as CFString,&p);AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&s)
        guard let p,let s,CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else{continue}
        var point=CGPoint.zero,size=CGSize.zero
        AXValueGetValue(p as! AXValue,.cgPoint,&point);AXValueGetValue(s as! AXValue,.cgSize,&size)
        if abs(point.x-target.frame.minX)<3 && abs(point.y-target.frame.minY)<3 && abs(size.width-target.frame.width)<3 && abs(size.height-target.frame.height)<3 {chosen=window;break}
    }
    guard let chosen else{throw BridgeError("选定的微信窗口位置已改变，请重新读取")}
    running.activate(options:[.activateAllWindows])
    guard AXUIElementPerformAction(chosen,kAXRaiseAction as CFString) == .success else{throw BridgeError("无法激活选定的微信窗口")}
}
func clickAt(_ point:CGPoint) throws {
    guard let down=CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left),let up=CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left) else{throw BridgeError("无法创建鼠标事件")}
    down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
}
func typeText(_ value:String) throws {
    var chunks:[String]=[],buffer=""
    for character in value {if buffer.utf16.count+String(character).utf16.count>16 {chunks.append(buffer);buffer=""};buffer.append(character)}
    if !buffer.isEmpty {chunks.append(buffer)}
    for chunk in chunks {
    let chars=Array(chunk.utf16)
    // A single Unicode event preserves emoji surrogate pairs and never touches the clipboard.
    guard let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false) else{throw BridgeError("无法创建输入事件")}
    chars.withUnsafeBufferPointer { ptr in
        down.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:ptr.baseAddress)
        up.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:ptr.baseAddress)
    }
    down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
    Thread.sleep(forTimeInterval:0.025)
    }
}
@available(macOS 14.0, *)
func send(_ payload:[String:Any]) async throws -> [String:Any] {
    guard let id=payload["windowId"] as? UInt32,let expected=payload["expectedTitle"] as? String,!expected.isEmpty,
          let text=payload["text"] as? String,!text.isEmpty,text.count<=1500,!text.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),
          let c=payload["calibration"] as? [String:Any],let input=c["input"] as? [String:Double],let ix=input["x"],let iy=input["y"] else{throw BridgeError("发送参数不完整")}
    let title=try Region(c["title"]),composer=try Region(c["composer"]),messages=try Region(c["messages"])
    guard let expectedOCR=payload["expectedOCR"] as? [String],!expectedOCR.isEmpty else{throw BridgeError("缺少发送前的消息校验记录")}
    let expectedSignature=expectedOCR.map(normalized)
    guard ix>=composer.x,ix<=composer.x+composer.w,iy>=composer.y,iy<=composer.y+composer.h else{throw BridgeError("输入位置不在已标记的输入框内")}
    if payload["automatic"] as? Bool == true && CGEventSource.secondsSinceLastEventType(.combinedSessionState,eventType:CGEventType(rawValue:UInt32.max)!)<5 {throw BridgeError("检测到人工操作，自动发送已取消")}
    let before=try await shot(id)
    guard titleMatches(before.lines,expected,title) else{throw BridgeError("聊天对象变化，已取消发送")}
    guard regionText(before.lines,messages)==expectedSignature else{throw BridgeError("客户消息发生变化，已取消发送")}
    guard let width=payload["width"] as? Int,let height=payload["height"] as? Int,abs(width-before.image.width)<3,abs(height-before.image.height)<3 else{throw BridgeError("微信窗口尺寸变化，请重新标记区域")}
    guard !existingDraft(before.lines,composer) else{throw BridgeError("微信输入框里已有内容，请先自行处理草稿")}
    try raiseWindow(before.window);try await Task.sleep(for:.milliseconds(450))
    let verified=try await shot(id)
    guard titleMatches(verified.lines,expected,title),!existingDraft(verified.lines,composer) else{throw BridgeError("发送前核对未通过，请重新读取会话")}
    guard regionText(verified.lines,messages)==expectedSignature else{throw BridgeError("客户有新消息，已取消发送")}
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier==verified.window.owningApplication?.processID else{throw BridgeError("微信没有获得焦点，已取消发送")}
    let point=CGPoint(x:verified.window.frame.minX+ix*verified.window.frame.width,y:verified.window.frame.minY+iy*verified.window.frame.height)
    try clickAt(point);try await Task.sleep(for:.milliseconds(180))
    var focused:CFTypeRef?,value:CFTypeRef?
    let axApp=AXUIElementCreateApplication(verified.window.owningApplication!.processID)
    if AXUIElementCopyAttributeValue(axApp,kAXFocusedUIElementAttribute as CFString,&focused) == .success,let focused,CFGetTypeID(focused)==AXUIElementGetTypeID() {
        AXUIElementCopyAttributeValue(focused as! AXUIElement,kAXValueAttribute as CFString,&value)
        if let existing=value as? String,!existing.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {throw BridgeError("输入框已有草稿，已取消发送")}
    }
    try typeText(text);try await Task.sleep(for:.milliseconds(250))
    let typed=try await shot(id)
    guard titleMatches(typed.lines,expected,title),regionText(typed.lines,messages)==expectedSignature else{throw BridgeError("发送前会话变化，请到微信检查草稿")}
    let composed=regionText(typed.lines,composer).filter{!["发送","发送s","send"].contains($0)}.joined()
    guard composed==normalized(text) else{throw BridgeError("未能确认输入框中的回复，请到微信检查草稿")}
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier==verified.window.owningApplication?.processID else{throw BridgeError("发送前焦点发生变化，请到微信检查草稿")}
    guard let down=CGEvent(keyboardEventSource:nil,virtualKey:36,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:36,keyDown:false) else{throw BridgeError("无法创建发送事件")}
    down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
    try await Task.sleep(for:.milliseconds(700));return ["attempted":true]
}
@main struct Main {
    static func main() async {
        do {
            let command=CommandLine.arguments.dropFirst().first ?? "help"
            let data=FileHandle.standardInput.readDataToEndOfFile()
            let payload=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
            var result:[String:Any]=[:]
            switch command {
            case "permissions":result=["screen":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted()]
            case "request-screen":result=["granted":CGRequestScreenCaptureAccess()]
            case "request-accessibility":
                let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
                result=["granted":AXIsProcessTrustedWithOptions(options)]
            case "windows":result=["windows":listedWindows()]
            case "capture":
                guard let id=payload["windowId"] as? UInt32 else{throw BridgeError("请选择微信窗口")}
                let shot=try await shot(id);let png=NSBitmapImageRep(cgImage:shot.image).representation(using:.png,properties:[:])!
                result=["windowId":id,"width":shot.image.width,"height":shot.image.height,"image":png.base64EncodedString(),"lines":shot.lines]
            case "send":result=try await send(payload)
            case "self-test":
                let r=try Region(["x":0.3,"y":0.01,"w":0.6,"h":0.1])
                guard titleMatches([["text":"测试客户（2）","box":["x":0.4,"y":0.03,"w":0.1,"h":0.02]]],"测试客户",r),
                      !titleMatches([["text":"其他客户","box":["x":0.4,"y":0.03,"w":0.1,"h":0.02]]],"测试客户",r) else{throw BridgeError("会话校验自检失败")}
                let colors=CGContext(data:nil,width:40,height:40,bitsPerComponent:8,bytesPerRow:160,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
                colors.setFillColor(CGColor(red:0.3,green:0.85,blue:0.3,alpha:1));colors.fill(CGRect(x:0,y:0,width:40,height:40))
                guard greenBackground(colors.makeImage()!,["x":0.3,"y":0.3,"w":0.4,"h":0.4]) else{throw BridgeError("发送气泡颜色自检失败")}
                colors.setFillColor(CGColor(red:1,green:1,blue:1,alpha:1));colors.fill(CGRect(x:0,y:0,width:40,height:40))
                guard !greenBackground(colors.makeImage()!,["x":0.3,"y":0.3,"w":0.4,"h":0.4]) else{throw BridgeError("接收气泡颜色自检失败")}
                result=["passed":true,"checks":["title-exact-match","outgoing-bubble","incoming-bubble"]]
            default:throw BridgeError("不支持的本机操作")
            }
            output(["ok":true,"data":result])
        }catch{output(["ok":false,"error":error.localizedDescription])}
    }
    static func output(_ value:[String:Any]){if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]){FileHandle.standardOutput.write(data)}}
}
