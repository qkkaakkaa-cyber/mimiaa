import AppKit
let side=1024
let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:side,pixelsHigh:side,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
NSColor(calibratedRed:11/255,green:92/255,blue:1,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:64,y:64,width:896,height:896),xRadius:210,yRadius:210).fill()
NSColor.white.setStroke()
let lengths:[CGFloat]=[125,290,470,340,170]
for (i,length) in lengths.enumerated(){let p=NSBezierPath();p.lineWidth=54;p.lineCapStyle = .round;p.move(to:NSPoint(x:300+CGFloat(i)*106,y:512-length/2));p.line(to:NSPoint(x:300+CGFloat(i)*106,y:512+length/2));p.stroke()}
NSGraphicsContext.restoreGraphicsState()
let data=rep.representation(using:.png,properties:[:])!
try data.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
