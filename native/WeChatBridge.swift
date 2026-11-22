import Foundation
import AppKit
import ScreenCaptureKit
import Vision
import ApplicationServices
import PDFKit

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
@MainActor
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
@main struct Main {
    @MainActor
    static func main() async {
        // ScreenCaptureKit's window/display filter requires a WindowServer
        // connection and must be initialized on the main actor in a CLI helper.
        do {
            let command=CommandLine.arguments.dropFirst().first ?? "help"
            if command=="capture" {
                let application=NSApplication.shared
                application.setActivationPolicy(.prohibited)
            }
            let data=FileHandle.standardInput.readDataToEndOfFile()
            let payload=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
            var result:[String:Any]=[:]
            switch command {
            case "permissions":result=["screen":CGPreflightScreenCaptureAccess()]
            case "request-screen":result=["granted":CGRequestScreenCaptureAccess()]
            case "windows":result=["windows":listedWindows()]
            case "extract-document":
                guard let path=payload["path"] as? String,path.lowercased().hasSuffix(".pdf"),let document=PDFDocument(url:URL(fileURLWithPath:path)) else{throw BridgeError("无法读取该 PDF 文档")}
                let text=(0..<document.pageCount).compactMap{document.page(at:$0)?.string}.joined(separator:"\n\n")
                result=["text":String(text.prefix(80000))]
            case "capture":
                guard let id=payload["windowId"] as? UInt32 else{throw BridgeError("请选择微信窗口")}
                let shot=try await shot(id);let png=NSBitmapImageRep(cgImage:shot.image).representation(using:.png,properties:[:])!
                let frame=shot.window.frame
                result=["windowId":id,"width":shot.image.width,"height":shot.image.height,"image":png.base64EncodedString(),"lines":shot.lines,
                        "window":["pid":shot.window.owningApplication!.processID,"frame":["x":frame.minX,"y":frame.minY,"w":frame.width,"h":frame.height]]]
            case "ocr-image":
                guard let base64=payload["image"] as? String,let data=Data(base64Encoded:base64),let rep=NSBitmapImageRep(data:data),let image=rep.cgImage else{throw BridgeError("无法读取本机截图")}
                let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate
                request.recognitionLanguages=["zh-Hans","zh-Hant","en-US"];request.usesLanguageCorrection=false
                try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
                let lines=(request.results ?? []).compactMap { observation -> [String:Any]? in
                    guard let text=observation.topCandidates(1).first,text.confidence>=0.45 else{return nil}
                    let b=observation.boundingBox
                    let rect:[String:Double]=["x":b.minX,"y":1-b.maxY,"w":b.width,"h":b.height]
                    return ["text":text.string,"confidence":text.confidence,"box":rect,"outgoing":greenBackground(image,rect)]
                }
                result=["lines":lines]
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
