#include <node_api.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cmath>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

// This module is loaded into Electron's main process. macOS therefore checks
// the same app identity the user granted in System Settings, rather than a CLI.
namespace {
constexpr int64_t automationEventTag = 0x5745495849414e47;
NSTimeInterval lastAutomationEvent = -INFINITY;
void markAutomation(CGEventRef down, CGEventRef up) {
  lastAutomationEvent = NSProcessInfo.processInfo.systemUptime;
  CGEventSetIntegerValueField(down, kCGEventSourceUserData, automationEventTag);
  CGEventSetIntegerValueField(up, kCGEventSourceUserData, automationEventTag);
}
napi_value field(napi_env env, napi_value object, const char *name) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok)
    throw std::runtime_error("本机操作参数不完整");
  return value;
}
double number(napi_env env, napi_value object, const char *name) {
  double value;
  if (napi_get_value_double(env, field(env, object, name), &value) != napi_ok || !std::isfinite(value))
    throw std::runtime_error("本机操作坐标无效");
  return value;
}
std::u16string text(napi_env env, napi_value object, const char *name) {
  size_t length=0;
  if (napi_get_value_string_utf16(env, field(env, object, name), nullptr, 0, &length) != napi_ok || length>32)
    throw std::runtime_error("本机输入片段无效");
  std::vector<char16_t> buffer(length+1);
  napi_get_value_string_utf16(env, field(env, object, name), buffer.data(), buffer.size(), &length);
  return {buffer.data(),length};
}
napi_value done(napi_env env) {napi_value value;napi_get_boolean(env,true,&value);return value;}
bool close(CGRect a,CGRect b) {
  return std::abs(a.origin.x-b.origin.x)<3 && std::abs(a.origin.y-b.origin.y)<3 &&
    std::abs(a.size.width-b.size.width)<3 && std::abs(a.size.height-b.size.height)<3;
}
CGRect bounds(AXUIElementRef window) {
  CFTypeRef position=nullptr,size=nullptr;
  CGPoint p=CGPointZero;CGSize s=CGSizeZero;
  AXUIElementCopyAttributeValue(window,kAXPositionAttribute,&position);
  AXUIElementCopyAttributeValue(window,kAXSizeAttribute,&size);
  if(position && size && CFGetTypeID(position)==AXValueGetTypeID() && CFGetTypeID(size)==AXValueGetTypeID()) {
    AXValueGetValue((AXValueRef)position,(AXValueType)kAXValueCGPointType,&p);
    AXValueGetValue((AXValueRef)size,(AXValueType)kAXValueCGSizeType,&s);
  }
  if(position)CFRelease(position);if(size)CFRelease(size);
  return CGRectMake(p.x,p.y,s.width,s.height);
}
struct Target {
  pid_t pid;CGRect frame;AXUIElementRef app;
  Target(napi_env env,napi_value params) {
    if(!AXIsProcessTrusted())throw std::runtime_error("微响尚未获得辅助功能权限，请在系统设置中开启");
    double rawPID=number(env,params,"pid");
    if(rawPID<=0 || rawPID>INT32_MAX || std::floor(rawPID)!=rawPID)throw std::runtime_error("微信进程编号无效");
    pid=(pid_t)rawPID;
    NSRunningApplication *running=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if(!running || !running.bundleIdentifier || ![@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:running.bundleIdentifier])
      throw std::runtime_error("只允许操作选定的微信进程");
    napi_value box=field(env,params,"frame");
    frame=CGRectMake(number(env,box,"x"),number(env,box,"y"),number(env,box,"w"),number(env,box,"h"));
    if(frame.size.width<300 || frame.size.height<300)throw std::runtime_error("微信窗口尺寸无效");
    app=AXUIElementCreateApplication(pid);
  }
  ~Target(){CFRelease(app);}
  void assertFocused() {
    if([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier!=pid)
      throw std::runtime_error("微信焦点已变化，已取消操作");
    CFTypeRef focused=nullptr;
    AXError status=AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute,&focused);
    bool matches=status==kAXErrorSuccess && focused && CFGetTypeID(focused)==AXUIElementGetTypeID() && close(bounds((AXUIElementRef)focused),frame);
    if(focused)CFRelease(focused);
    if(!matches)throw std::runtime_error("当前窗口与选定的微信窗口不一致");
  }
};
napi_value run(napi_env env,napi_callback_info info,void(*callback)(napi_env,napi_value)) {
  @autoreleasepool {
    try {napi_value arg;size_t count=1;napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);
      if(count!=1)throw std::runtime_error("缺少本机操作参数");callback(env,arg);return done(env);
    }catch(const std::exception &error){napi_throw_error(env,nullptr,error.what());return nullptr;}
  }
}
AXUIElementRef findTargetWindow(const Target &target) {
  CFTypeRef raw=nullptr;
  if(AXUIElementCopyAttributeValue(target.app,kAXWindowsAttribute,&raw)!=kAXErrorSuccess || !raw || CFGetTypeID(raw)!=CFArrayGetTypeID()) {
    if(raw)CFRelease(raw);throw std::runtime_error("无法定位微信窗口，请检查权限是否生效");
  }
  AXUIElementRef chosen=nullptr;CFArrayRef windows=(CFArrayRef)raw;
  for(CFIndex i=0;i<CFArrayGetCount(windows);i++) {
    AXUIElementRef candidate=(AXUIElementRef)CFArrayGetValueAtIndex(windows,i);
    if(close(bounds(candidate),target.frame)){chosen=(AXUIElementRef)CFRetain(candidate);break;}
  }
  CFRelease(raw);
  if(!chosen)throw std::runtime_error("微信窗口布局已变化，请重新读取");
  return chosen;
}
AXError raiseWeChatWindow(NSRunningApplication *wechat,AXUIElementRef window) {
  if (NSApp.isActive) {
    [NSApp yieldActivationToApplication:wechat];
    [wechat activateFromApplication:NSRunningApplication.currentApplication options:NSApplicationActivateAllWindows];
  } else {
    [wechat activateWithOptions:NSApplicationActivateAllWindows];
  }
  return AXUIElementPerformAction(window,kAXRaiseAction);
}
void focus(napi_env env,napi_value params) {
  Target target(env,params);
  AXUIElementRef chosen=findTargetWindow(target);
  NSRunningApplication *wechat=[NSRunningApplication runningApplicationWithProcessIdentifier:target.pid];
  AXError result=raiseWeChatWindow(wechat,chosen);
  CFRelease(chosen);
  if(result!=kAXErrorSuccess)throw std::runtime_error("无法激活已选定的微信窗口");
}
void clickInput(napi_env env,napi_value params) {
  Target target(env,params);target.assertFocused();
  napi_value input=field(env,params,"input");double x=number(env,input,"x"),y=number(env,input,"y");
  if(x<0||x>1||y<0||y>1)throw std::runtime_error("输入位置超出窗口范围");
  CGPoint point=CGPointMake(target.frame.origin.x+x*target.frame.size.width,target.frame.origin.y+y*target.frame.size.height);
  bool hasHold=false;napi_has_named_property(env,params,"hold",&hasHold);
  double hold=hasHold?number(env,params,"hold"):0;
  if(hold<0||hold>1500)throw std::runtime_error("按键时长无效");
  CGEventRef down=CGEventCreateMouseEvent(nullptr,kCGEventLeftMouseDown,point,kCGMouseButtonLeft);
  CGEventRef up=CGEventCreateMouseEvent(nullptr,kCGEventLeftMouseUp,point,kCGMouseButtonLeft);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建输入事件");}
  markAutomation(down,up);
  CGEventPost(kCGHIDEventTap,down);
  if(hold)std::this_thread::sleep_for(std::chrono::milliseconds((int)hold));
  CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
void type(napi_env env,napi_value params) {
  Target target(env,params);target.assertFocused();std::u16string chars=text(env,params,"text");
  for(char16_t character:chars)if(character<32||character==127)throw std::runtime_error("回复中包含不支持的控制字符");
  CGEventRef down=CGEventCreateKeyboardEvent(nullptr,0,true),up=CGEventCreateKeyboardEvent(nullptr,0,false);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建文字输入事件");}
  markAutomation(down,up);
  CGEventKeyboardSetUnicodeString(down,chars.size(),reinterpret_cast<const UniChar *>(chars.data()));
  CGEventKeyboardSetUnicodeString(up,chars.size(),reinterpret_cast<const UniChar *>(chars.data()));
  CGEventPost(kCGHIDEventTap,down);CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
void commit(napi_env env,napi_value params) {
  Target target(env,params);target.assertFocused();
  CGEventRef down=CGEventCreateKeyboardEvent(nullptr,36,true),up=CGEventCreateKeyboardEvent(nullptr,36,false);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建发送事件");}
  markAutomation(down,up);
  CGEventPost(kCGHIDEventTap,down);CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
napi_value Focus(napi_env e,napi_callback_info i){return run(e,i,focus);}
napi_value Click(napi_env e,napi_callback_info i){return run(e,i,clickInput);}
napi_value Type(napi_env e,napi_callback_info i){return run(e,i,type);}
napi_value Commit(napi_env e,napi_callback_info i){return run(e,i,commit);}
napi_value Trusted(napi_env env,napi_callback_info info){napi_value out;napi_get_boolean(env,AXIsProcessTrusted(),&out);return out;}
NSString *stringAttr(AXUIElementRef node, CFStringRef key) {
  CFTypeRef value=nullptr;AXUIElementCopyAttributeValue(node,key,&value);
  NSString *result=@"";
  if(value && CFGetTypeID(value)==CFStringGetTypeID())result=[(__bridge NSString*)value copy];
  if(value)CFRelease(value);return result;
}
bool boolAttr(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value=nullptr;
  AXUIElementCopyAttributeValue(element,key,&value);
  const bool result=value&&CFGetTypeID(value)==CFBooleanGetTypeID()&&CFBooleanGetValue((CFBooleanRef)value);
  if (value) CFRelease(value);
  return result;
}
NSDictionary *rectJSON(CGRect r){return @{@"x":@(r.origin.x),@"y":@(r.origin.y),@"w":@(r.size.width),@"h":@(r.size.height)};}
void walk(AXUIElementRef node,NSMutableArray *items,int depth,int &count) {
  if(depth>16 || count++>3500)return;
  NSString *identifier=stringAttr(node,kAXIdentifierAttribute);
  NSString *value=stringAttr(node,kAXValueAttribute),*label=stringAttr(node,kAXDescriptionAttribute),*title=stringAttr(node,kAXTitleAttribute);
  if(identifier.length || label.length || title.length || value.length){
    [items addObject:@{@"id":identifier,@"value":value,@"label":label,@"title":title,@"frame":rectJSON(bounds(node)),@"role":stringAttr(node,kAXRoleAttribute),@"depth":@(depth)}];
  }
  CFTypeRef children=nullptr;
  if(AXUIElementCopyAttributeValue(node,kAXChildrenAttribute,&children)==kAXErrorSuccess && children && CFGetTypeID(children)==CFArrayGetTypeID()){
    for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)children);i++)walk((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children,i),items,depth+1,count);
  }
  if(children)CFRelease(children);
}
napi_value inspectWindow(napi_env env,bool social){
 @autoreleasepool {try{
  if(!AXIsProcessTrusted())throw std::runtime_error("请先为微响开启辅助功能权限");
  NSRunningApplication *running=nil;
  for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)if([@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:app.bundleIdentifier]){running=app;break;}
  if(!running)throw std::runtime_error("请先登录电脑微信");
  if(!social&&running.hidden)throw std::runtime_error("请展开微信的聊天列表，微信主窗口已隐藏");
  AXUIElementRef app=AXUIElementCreateApplication(running.processIdentifier);CFTypeRef windows=nullptr;
  AXUIElementCopyAttributeValue(app,kAXWindowsAttribute,&windows);CFRelease(app);
  NSMutableArray *results=[NSMutableArray array];
  bool mainMinimized=false;
  if(windows && CFGetTypeID(windows)==CFArrayGetTypeID())for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)windows);i++){
    AXUIElementRef win=(AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)windows,i);
    if(!social&&boolAttr(win,kAXMinimizedAttribute)){
      NSString *title=stringAttr(win,kAXTitleAttribute);
      if ([title isEqualToString:@"WeChat"] || [title isEqualToString:@"微信"])mainMinimized=true;
      continue;
    }
    NSMutableArray *items=[NSMutableArray array];int count=0;walk(win,items,0,count);
    BOOL hasSessions=NO;for(NSDictionary *item in items)if([item[@"id"] isEqual:@"session_list"])hasSessions=YES;
    if(!social&&!hasSessions)continue;
    CGRect frame=bounds(win);NSNumber *windowID=nil;
    NSArray *infos=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *entry in infos){CGRect candidate;NSDictionary *box=entry[(id)kCGWindowBounds];if([entry[(id)kCGWindowOwnerPID] intValue]==running.processIdentifier && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)box,&candidate) && close(candidate,frame)){windowID=entry[(id)kCGWindowNumber];break;}}
    if(!windowID)continue;
    [results addObject:@{@"pid":@(running.processIdentifier),@"frame":rectJSON(frame),@"windowId":windowID,@"items":items,@"title":stringAttr(win,kAXTitleAttribute)}];if(!social)break;
  }
  if(windows)CFRelease(windows);
  if (!results.count && mainMinimized)
    throw std::runtime_error("请展开微信的聊天列表，微信主窗口已最小化");
  if(!results.count)throw std::runtime_error(social?"请打开电脑微信":"请展开微信的聊天列表，微响会自动识别");
  NSData *json=[NSJSONSerialization dataWithJSONObject:social?(id)results:results.firstObject options:0 error:nil];napi_value out;napi_create_string_utf8(env,(const char*)json.bytes,json.length,&out);return out;
 }catch(const std::exception &error){napi_throw_error(env,nullptr,error.what());return nullptr;}}
}
napi_value Inspect(napi_env env,napi_callback_info info){return inspectWindow(env,false);}
napi_value InspectSocial(napi_env env,napi_callback_info info){return inspectWindow(env,true);}

struct CaptureContext {napi_deferred deferred;};
struct CaptureOutcome {std::string json;std::string error;};
void captureCallback(napi_env env,napi_value js,void *context,void *data){
 auto *state=(CaptureContext*)context;auto *outcome=(CaptureOutcome*)data;
 if(env){napi_value result;
  if(!outcome->error.empty()){napi_value message;napi_create_string_utf8(env,outcome->error.c_str(),NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&result);napi_reject_deferred(env,state->deferred,result);}
  else{napi_create_string_utf8(env,outcome->json.c_str(),outcome->json.size(),&result);napi_resolve_deferred(env,state->deferred,result);}
 }
 delete outcome;delete state;
}
void settleCapture(napi_threadsafe_function callback,NSDictionary *value,NSString *error){
 NSData *json=value?[NSJSONSerialization dataWithJSONObject:value options:0 error:nil]:nil;
 auto *outcome=new CaptureOutcome{json?std::string((const char*)json.bytes,json.length):"",error?std::string(error.UTF8String):""};
 if(napi_call_threadsafe_function(callback,outcome,napi_tsfn_nonblocking)!=napi_ok)delete outcome;
 napi_release_threadsafe_function(callback,napi_tsfn_release);
}
napi_value Capture(napi_env env,napi_callback_info info){
 napi_value arg;size_t count=1;napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);
 double requested;try{requested=number(env,arg,"windowId");}catch(const std::exception &e){napi_throw_error(env,nullptr,e.what());return nullptr;}
 napi_deferred deferred;napi_value promise;napi_create_promise(env,&deferred,&promise);
 napi_value resourceName;napi_create_string_utf8(env,"HuixiangCapture",NAPI_AUTO_LENGTH,&resourceName);
 napi_threadsafe_function callback;auto *context=new CaptureContext{deferred};
 if(napi_create_threadsafe_function(env,nullptr,nullptr,resourceName,1,1,nullptr,nullptr,context,captureCallback,&callback)!=napi_ok){delete context;napi_throw_error(env,nullptr,"无法创建截图回调");return nullptr;}

 if(!CGPreflightScreenCaptureAccess()){settleCapture(callback,nil,@"需要为当前微响开启屏幕录制权限");return promise;}
 [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content,NSError *error){
  if(error){settleCapture(callback,nil,error.localizedDescription);return;}
  dispatch_async(dispatch_get_main_queue(), ^{
   SCWindow *selected=nil;for(SCWindow *candidate in content.windows)if(candidate.windowID==(CGWindowID)requested){selected=candidate;break;}
   if(!selected || ![@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:selected.owningApplication.bundleIdentifier]){settleCapture(callback,nil,@"未找到可核对的微信窗口");return;}
   SCContentFilter *filter=[[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
   SCStreamConfiguration *config=[SCStreamConfiguration new];config.width=(size_t)selected.frame.size.width;config.height=(size_t)selected.frame.size.height;config.showsCursor=NO;config.ignoreShadowsSingleWindow=YES;
   [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image,NSError *error){
    if(error||!image){settleCapture(callback,nil,error.localizedDescription?:@"微信截图失败");return;}
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithCGImage:image];NSData *png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSDictionary *value=@{@"windowId":@((uint32_t)requested),@"width":@(CGImageGetWidth(image)),@"height":@(CGImageGetHeight(image)),@"image":[png base64EncodedStringWithOptions:0],@"window":@{@"pid":@(selected.owningApplication.processID),@"frame":rectJSON(selected.frame)}};
    settleCapture(callback,value,nil);
   }];
  });
 }];return promise;
}
napi_value ScreenTrusted(napi_env env,napi_callback_info info){napi_value value;napi_get_boolean(env,CGPreflightScreenCaptureAccess(),&value);return value;}
napi_value RequestScreen(napi_env env,napi_callback_info info){napi_value value;napi_get_boolean(env,CGRequestScreenCaptureAccess(),&value);return value;}

AXUIElementRef findElement(AXUIElementRef root,NSString *identifier,NSString *buttonTitle,int depth=0){
 if(depth>16)return nullptr;
 NSString *id=stringAttr(root,kAXIdentifierAttribute),*role=stringAttr(root,kAXRoleAttribute);
 if((identifier.length&&[id isEqual:identifier])||(buttonTitle.length&&[role isEqual:(__bridge NSString*)kAXButtonRole]&&([stringAttr(root,kAXTitleAttribute) isEqual:buttonTitle]||[stringAttr(root,kAXDescriptionAttribute) isEqual:buttonTitle])))return (AXUIElementRef)CFRetain(root);
 CFTypeRef children=nullptr;AXUIElementCopyAttributeValue(root,kAXChildrenAttribute,&children);AXUIElementRef found=nullptr;
 if(children&&CFGetTypeID(children)==CFArrayGetTypeID())for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)children);i++){found=findElement((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children,i),identifier,buttonTitle,depth+1);if(found)break;}
 if(children)CFRelease(children);return found;
}
NSString *longString(napi_env env,napi_value params,const char *key,size_t limit=7000){
 napi_value value=field(env,params,key);size_t size=0;if(napi_get_value_string_utf8(env,value,nullptr,0,&size)!=napi_ok||size>limit)throw std::runtime_error("后台输入内容无效");
 std::vector<char> data(size+1);napi_get_value_string_utf8(env,value,data.data(),data.size(),&size);return [[NSString alloc] initWithBytes:data.data() length:size encoding:NSUTF8StringEncoding];
}
bool weChatInUse();
void selectChatRow(napi_env env,napi_value params) {
  Target target(env,params);
  NSString *identifier=longString(env,params,"id",1000);
  if (![identifier hasPrefix:@"session_item_"] || [identifier isEqualToString:@"session_item_折叠的聊天"])
    throw std::runtime_error("只允许选择主列表中的会话");
  if (weChatInUse()) throw std::runtime_error("你正在使用微信，稍后继续接待");
  AXUIElementRef window=findTargetWindow(target);
  AXUIElementRef list=findElement(window,@"session_list",nil);
  CFRelease(window);
  if (!list) throw std::runtime_error("未找到微信会话列表");
  BOOL folded=[stringAttr(list,kAXDescriptionAttribute) isEqualToString:@"折叠的聊天"] ||
    [stringAttr(list,kAXTitleAttribute) isEqualToString:@"折叠的聊天"];
  AXUIElementRef row=folded ? nullptr : findElement(list,identifier,nil);
  const CGRect listFrame=bounds(list);
  CFRelease(list);
  if(!row)throw std::runtime_error("微信会话已离开主列表");
  const CGRect visible=CGRectIntersection(CGRectIntersection(bounds(row),listFrame),target.frame);
  if(CGRectIsNull(visible)||visible.size.height<12||visible.size.width<25) {
    CFRelease(row);
    throw std::runtime_error("微信会话暂时不可见");
  }
  CFArrayRef actions=nullptr;
  bool supportsPress=false;
  if (AXUIElementCopyActionNames(row,&actions)==kAXErrorSuccess&&actions)
    supportsPress=CFArrayContainsValue(actions,CFRangeMake(0,CFArrayGetCount(actions)),kAXPressAction);
  if(actions)CFRelease(actions);
  if (weChatInUse()) {
    CFRelease(row);
    throw std::runtime_error("你正在使用微信，稍后继续接待");
  }
  if (supportsPress) {
    const AXError result=AXUIElementPerformAction(row,kAXPressAction);
    CFRelease(row);
    if (result!=kAXErrorSuccess)
      throw std::runtime_error("微信会话的辅助功能操作未确认");
    return;
  }
  CFRelease(row);
  const CGPoint point=CGPointMake(CGRectGetMidX(visible),CGRectGetMidY(visible));
  CGEventRef down=CGEventCreateMouseEvent(nullptr,kCGEventLeftMouseDown,point,kCGMouseButtonLeft);
  CGEventRef up=CGEventCreateMouseEvent(nullptr,kCGEventLeftMouseUp,point,kCGMouseButtonLeft);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建会话选择事件");}
  markAutomation(down,up);
  CGEventPostToPid(target.pid,down);
  CGEventPostToPid(target.pid,up);
  CFRelease(down);CFRelease(up);
}
napi_value SelectChatRow(napi_env env,napi_callback_info info){return run(env,info,selectChatRow);}
AXUIElementRef verifiedChat(Target &target,NSString *expected){
 AXUIElementRef chosen=findTargetWindow(target);
 AXUIElementRef title=findElement(chosen,@"current_chat_name_label",nil);
 const bool usesHeader=!title;
 if(usesHeader)title=findElement(chosen,@"big_title_line_h_view",nil);
 NSString *name=title?stringAttr(title,kAXValueAttribute):@"";
 if(title)CFRelease(title);name=[name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
 NSRegularExpression *count=[NSRegularExpression regularExpressionWithPattern:@"\\s*[（(][0-9]+[)）]\\s*$" options:0 error:nil];name=[count stringByReplacingMatchesInString:name options:0 range:NSMakeRange(0,name.length) withTemplate:@""];
 if(usesHeader&&[name hasPrefix:[expected stringByAppendingString:@" @"]]){
   AXUIElementRef row=findElement(chosen,[@"session_item_" stringByAppendingString:expected],nil);
   if(row){name=expected;CFRelease(row);}
 }
 if(![name isEqual:expected]){CFRelease(chosen);throw std::runtime_error("聊天对象已变化，停止后台输入");}return chosen;
}
void writeMoment(napi_env env,napi_value params){
 Target target(env,params);target.assertFocused();NSString *draft=longString(env,params,"text");
 CFTypeRef raw=nullptr;AXUIElementCopyAttributeValue(target.app,kAXFocusedWindowAttribute,&raw);
 if(!raw||CFGetTypeID(raw)!=AXUIElementGetTypeID()){if(raw)CFRelease(raw);throw std::runtime_error("未找到朋友圈编辑器");}
 auto win=(AXUIElementRef)raw;
 if(![stringAttr(win,kAXTitleAttribute) isEqual:@"朋友圈"]){
   CFRelease(raw);throw std::runtime_error("当前窗口不是朋友圈编辑器");
 }
 AXUIElementRef publish=findElement(win,nil,@"发表"),cancel=findElement(win,nil,@"取消");
 bool editor=publish&&cancel;
 if(publish)CFRelease(publish);if(cancel)CFRelease(cancel);
 if(!editor){CFRelease(raw);throw std::runtime_error("无法确认朋友圈编辑器");}
 CFTypeRef children=nullptr;AXUIElementCopyAttributeValue(win,kAXChildrenAttribute,&children);CFRelease(raw);
 AXUIElementRef input=nullptr;
 if(children&&CFGetTypeID(children)==CFArrayGetTypeID())for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)children);i++){
   auto node=(AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children,i);
   if([stringAttr(node,kAXRoleAttribute) isEqual:@"AXTextArea"]){input=(AXUIElementRef)CFRetain(node);break;}
 }
 if(children)CFRelease(children);
 if(!input)throw std::runtime_error("未找到朋友圈正文输入框");
 if(stringAttr(input,kAXValueAttribute).length){CFRelease(input);throw std::runtime_error("朋友圈已留有草稿，请先处理");}
 AXError result=AXUIElementSetAttributeValue(input,kAXValueAttribute,(__bridge CFStringRef)draft);
 CFRelease(input);if(result!=kAXErrorSuccess)throw std::runtime_error("微信未接受正文，请复制草稿后粘贴");
}
napi_value WriteMoment(napi_env e,napi_callback_info i){return run(e,i,writeMoment);}
struct PreparedDraft {
  pid_t pid = 0;
  NSString *header = nil;
  NSUInteger length = 0;
  NSUInteger hash = 0;
};
PreparedDraft preparedDraft;

NSString *chatHeader(AXUIElementRef window) {
  AXUIElementRef header = findElement(window, @"big_title_line_h_view", nil);
  if (!header) header = findElement(window, @"current_chat_name_label", nil);
  NSString *value = header ? stringAttr(header, kAXValueAttribute) : @"";
  if (header) CFRelease(header);
  return value;
}
void setComposer(napi_env env,napi_value params){
 Target target(env,params);NSString *reply=longString(env,params,"text"),*expected=longString(env,params,"expectedTitle");
 AXUIElementRef win=verifiedChat(target,expected),input=findElement(win,@"chat_input_field",nil);
 NSString *header=chatHeader(win);CFRelease(win);
 if(!input)throw std::runtime_error("无法定位微信输入框");
 NSString *existing=stringAttr(input,kAXValueAttribute);if(existing.length){CFRelease(input);throw std::runtime_error("微信已有草稿，保留给你处理");}
 Boolean settable=false;AXUIElementIsAttributeSettable(input,kAXValueAttribute,&settable);
 if(!settable){CFRelease(input);throw std::runtime_error("当前微信不支持后台输入");}
 AXError result=AXUIElementSetAttributeValue(input,kAXValueAttribute,(__bridge CFStringRef)reply);CFRelease(input);
 if(result!=kAXErrorSuccess)throw std::runtime_error("微信拒绝后台输入，已停止本次回复");
 preparedDraft = {target.pid, header, reply.length, reply.hash};
}
bool isWeChat(NSRunningApplication *application) {
  NSString *identifier = application.bundleIdentifier;
  return [identifier isEqualToString:@"com.tencent.xinWeChat"] ||
         [identifier isEqualToString:@"com.tencent.WeChat"];
}
AXUIElementRef focusedWindow(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef focused = nullptr;
  AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &focused);
  CFRelease(app);
  if (focused && CFGetTypeID(focused) == AXUIElementGetTypeID())
    return (AXUIElementRef)focused;
  if (focused) CFRelease(focused);
  return nullptr;
}

id activityMonitor = nil;
pid_t manualWeChatPID = 0;
NSTimeInterval lastManualInteraction = 0;
constexpr NSTimeInterval manualHold = 30.0;
pid_t lastForegroundPID = 0;
uint32_t lastHardwareKeys = 0;
uint32_t lastHardwarePointer = 0;

void checkHardwareInteraction(NSRunningApplication *foreground, AXUIElementRef window) {
  const pid_t pid = foreground.processIdentifier;
  const uint32_t keys = CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown);
  const uint32_t pointer =
    CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventLeftMouseDown) +
    CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventRightMouseDown) +
    CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventOtherMouseDown) +
    CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventScrollWheel);
  const bool pressedInSameApp = pid == lastForegroundPID && keys != lastHardwareKeys;
  const bool pointerChanged = lastForegroundPID && pointer != lastHardwarePointer;
  lastForegroundPID = pid;
  lastHardwareKeys = keys;
  lastHardwarePointer = pointer;

  const NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  if (!window || now - lastAutomationEvent < 1 || (!pressedInSameApp && !pointerChanged)) return;
  if (!pressedInSameApp) {
    CGEventRef cursor = CGEventCreate(nullptr);
    if (!cursor) return;
    const bool inWindow = CGRectContainsPoint(bounds(window), CGEventGetLocation(cursor));
    CFRelease(cursor);
    if (!inWindow) return;
  }
  manualWeChatPID = pid;
  lastManualInteraction = now;
}

void observeWeChatActivity() {
  if (activityMonitor || !AXIsProcessTrusted()) return;
  const NSEventMask mask = NSEventMaskKeyDown | NSEventMaskLeftMouseDown |
    NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown | NSEventMaskScrollWheel |
    NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
  activityMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) {
    CGEventRef raw = event.CGEvent;
    if (!raw || CGEventGetIntegerValueField(raw, kCGEventSourceUserData) == automationEventTag ||
        CGEventGetIntegerValueField(raw, kCGEventSourceUnixProcessID) == NSProcessInfo.processInfo.processIdentifier)
      return;
    NSRunningApplication *foreground = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!isWeChat(foreground)) return;

    pid_t pid = foreground.processIdentifier;
    const int64_t target = CGEventGetIntegerValueField(raw, kCGEventTargetUnixProcessID);
    if (target > 0 && target != pid) return;
    if (target <= 0 && event.type != NSEventTypeKeyDown) {
      AXUIElementRef window = focusedWindow(pid);
      if (!window) return;
      const bool inWindow = CGRectContainsPoint(bounds(window), CGEventGetLocation(raw));
      CFRelease(window);
      if (!inWindow) return;
    }

    // Only retain who is using the app and when, never what they typed.
    manualWeChatPID = pid;
    lastManualInteraction = NSProcessInfo.processInfo.systemUptime;
  }];
}
bool weChatInUse() {
  observeWeChatActivity();
  NSRunningApplication *foreground = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!isWeChat(foreground)) {
    checkHardwareInteraction(foreground, nullptr);
    manualWeChatPID = 0;
    return false;
  }
  const pid_t pid = foreground.processIdentifier;
  AXUIElementRef window = focusedWindow(pid);
  checkHardwareInteraction(foreground, window);
  if (pid == manualWeChatPID && NSProcessInfo.processInfo.systemUptime - lastManualInteraction < manualHold) {
    if (window) CFRelease(window);
    return true;
  }

  // This also protects drafts entered through accessibility or input methods.
  AXUIElementRef composer = window ? findElement(window, @"chat_input_field", nil) : nullptr;
  NSString *draft = composer ? stringAttr(composer, kAXValueAttribute) : @"";
  const bool ourDraft = draft.length && pid == preparedDraft.pid &&
    draft.length == preparedDraft.length && draft.hash == preparedDraft.hash &&
    [chatHeader(window) isEqualToString:preparedDraft.header];
  if (composer) CFRelease(composer);
  if (window) CFRelease(window);
  manualWeChatPID = 0;
  return draft.length && !ourDraft;
}
void pressSend(napi_env env,napi_value params){
 Target target(env,params);NSString *reply=longString(env,params,"text"),*expected=longString(env,params,"expectedTitle");
 if(weChatInUse())throw std::runtime_error("你正在使用微信，自动暂停");
 AXUIElementRef win=verifiedChat(target,expected),input=findElement(win,@"chat_input_field",nil);
 NSString *existing=input?stringAttr(input,kAXValueAttribute):@"";
 if(input){
  if([existing isEqual:reply])AXUIElementSetAttributeValue(input,kAXFocusedAttribute,kCFBooleanTrue);
  CFRelease(input);
 }
 if(![existing isEqual:reply]){CFRelease(win);throw std::runtime_error("输入内容已变化，不执行发送");}
 bool hasHistory=false;napi_has_named_property(env,params,"expectedMessages",&hasHistory);
 if(hasHistory){
  NSString *historyJSON=longString(env,params,"expectedMessages",60000);NSArray *expectedHistory=[NSJSONSerialization JSONObjectWithData:[historyJSON dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  NSMutableArray *items=[NSMutableArray array];int count=0;walk(win,items,0,count);NSMutableArray *actualHistory=[NSMutableArray array];
  for(NSDictionary *item in items)if([item[@"id"] isEqual:@"chat_bubble_item_view"]){NSString *value=item[@"value"];if(!value.length)value=item[@"label"];if(!value.length)value=item[@"title"];[actualHistory addObject:value?:@""];}
  if(![expectedHistory isKindOfClass:NSArray.class]||![actualHistory isEqualToArray:expectedHistory]){CFRelease(win);throw std::runtime_error("发送前客户消息发生变化，保留草稿");}
 }
 AXUIElementRef button=findElement(win,nil,@"发送");if(!button)button=findElement(win,nil,@"Send");CFRelease(win);
 if(!button)throw std::runtime_error("无法定位微信发送按钮");
 CFTypeRef enabled=nullptr;AXUIElementCopyAttributeValue(button,kAXEnabledAttribute,&enabled);bool ready=enabled&&CFGetTypeID(enabled)==CFBooleanGetTypeID()&&CFBooleanGetValue((CFBooleanRef)enabled);if(enabled)CFRelease(enabled);
 if(!ready){CFRelease(button);throw std::runtime_error("微信发送按钮尚不可用");}
 CFRelease(button);
 if(weChatInUse())throw std::runtime_error("你正在使用微信，自动暂停");
 // Deliver Return only to the validated WeChat process. Global keyboard focus
 // and the user's current application are untouched.
 CGEventRef down=CGEventCreateKeyboardEvent(nullptr,36,true),up=CGEventCreateKeyboardEvent(nullptr,36,false);
 if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建微信进程发送事件");}
 markAutomation(down,up);
 CGEventSetFlags(down,0);CGEventSetFlags(up,0);
 CGEventPostToPid(target.pid,down);CGEventPostToPid(target.pid,up);CFRelease(down);CFRelease(up);
}
napi_value SetComposer(napi_env e,napi_callback_info i){return run(e,i,setComposer);}
napi_value PressSend(napi_env e,napi_callback_info i){return run(e,i,pressSend);}
napi_value WeChatInUse(napi_env env,napi_callback_info info) {
  napi_value value;
  napi_get_boolean(env, weChatInUse(), &value);
  return value;
}
napi_value StopWeChatActivityMonitor(napi_env env,napi_callback_info info) {
  if (activityMonitor) [NSEvent removeMonitor:activityMonitor];
  activityMonitor = nil;
  manualWeChatPID = 0;
  lastForegroundPID = 0;
  return done(env);
}
napi_value FrontmostPID(napi_env env,napi_callback_info i){napi_value value;napi_create_int32(env,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,&value);return value;}
void restoreFocus(napi_env env,napi_value params){
 double raw=number(env,params,"pid");
 if(raw<=0 || raw>INT32_MAX || std::floor(raw)!=raw)throw std::runtime_error("原应用进程无效");
 NSString *current=NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
 if(![@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:current])return;
 NSRunningApplication *previous=[NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)raw];
 if(previous && !previous.terminated)[previous activateWithOptions:NSApplicationActivateAllWindows];
}
napi_value RestoreFocus(napi_env e,napi_callback_info i){return run(e,i,restoreFocus);}

AXUIElementRef weChatMainWindow(pid_t pid) {
  AXUIElementRef app=AXUIElementCreateApplication(pid);
  CFTypeRef windows=nullptr;
  AXUIElementCopyAttributeValue(app,kAXWindowsAttribute,&windows);
  CFRelease(app);
  AXUIElementRef main=nullptr;
  if (windows&&CFGetTypeID(windows)==CFArrayGetTypeID()) {
    const CFArrayRef list=(CFArrayRef)windows;
    for (CFIndex i=0;i<CFArrayGetCount(list);i++) {
      AXUIElementRef candidate=(AXUIElementRef)CFArrayGetValueAtIndex(list,i);
      AXUIElementRef split=findElement(candidate,@"main_window_main_splitter_view",nil);
      NSString *title=stringAttr(candidate,kAXTitleAttribute);
      if (split) CFRelease(split);
      if (!split && ![title isEqualToString:@"WeChat"] && ![title isEqualToString:@"微信"]) continue;
      if (!main || split) {
        if (main) CFRelease(main);
        main=(AXUIElementRef)CFRetain(candidate);
      }
      if (split) break;
    }
  }
  if (windows) CFRelease(windows);
  return main;
}

napi_value RevealWeChatWindow(napi_env env,napi_callback_info) {
  @autoreleasepool {
    try {
      if (!AXIsProcessTrusted()) throw std::runtime_error("请先为微响开启辅助功能权限");
      if (weChatInUse()) throw std::runtime_error("你正在使用微信，稍后恢复窗口");
      NSRunningApplication *wechat=nil;
      for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        if (isWeChat(app)) { wechat=app; break; }
      }
      if (!wechat) throw std::runtime_error("请先登录电脑微信");
      const pid_t pid=wechat.processIdentifier;
      AXUIElementRef main=weChatMainWindow(pid);
      if (!main) throw std::runtime_error("微信主窗口尚未打开");
      const bool hidden=wechat.hidden;
      const bool minimized=boolAttr(main,kAXMinimizedAttribute);
      if (hidden && ![wechat unhide]) {
        CFRelease(main);
        throw std::runtime_error("微信主窗口暂时无法取消隐藏");
      }
      const AXError result=minimized
        ? AXUIElementSetAttributeValue(main,kAXMinimizedAttribute,kCFBooleanFalse) : kAXErrorSuccess;
      if (result==kAXErrorSuccess && (hidden || minimized)) raiseWeChatWindow(wechat,main);
      CFRelease(main);
      if (result!=kAXErrorSuccess) {
        if (hidden) [wechat hide];
        throw std::runtime_error("微信主窗口暂时无法取消最小化");
      }
      napi_value out, value;
      napi_create_object(env,&out);
      napi_create_int32(env,pid,&value);
      napi_set_named_property(env,out,"pid",value);
      napi_get_boolean(env,hidden,&value);
      napi_set_named_property(env,out,"hidden",value);
      napi_get_boolean(env,minimized,&value);
      napi_set_named_property(env,out,"minimized",value);
      return out;
    } catch (const std::exception &error) {
      napi_throw_error(env,nullptr,error.what());
      return nullptr;
    }
  }
}
void parkWeChatWindow(napi_env env,napi_value params) {
  const double raw=number(env,params,"pid");
  if(raw<=0||raw>INT32_MAX||std::floor(raw)!=raw)
    throw std::runtime_error("无效的微信窗口进程");
  const pid_t pid=(pid_t)raw;
  NSRunningApplication *wechat=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if(!isWeChat(wechat)||weChatInUse())throw std::runtime_error("微信窗口已变化或正在使用");
  bool hidden=false,minimized=false;
  napi_get_value_bool(env,field(env,params,"hidden"),&hidden);
  napi_get_value_bool(env,field(env,params,"minimized"),&minimized);
  if(minimized){
    AXUIElementRef main=weChatMainWindow(pid);
    if(!main)throw std::runtime_error("微信主窗口已变化");
    const AXError status=AXUIElementSetAttributeValue(main,kAXMinimizedAttribute,kCFBooleanTrue);
    CFRelease(main);
    if(status!=kAXErrorSuccess)throw std::runtime_error("微信主窗口暂时无法最小化");
  }
  if(hidden&&!wechat.hidden&&![wechat hide])throw std::runtime_error("暂时无法重新隐藏微信");
}
napi_value ParkWeChatWindow(napi_env env,napi_callback_info info){return run(env,info,parkWeChatWindow);}

napi_value Init(napi_env env,napi_value exports){
  napi_property_descriptor methods[]={
    {"setComposer",nullptr,SetComposer,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"selectChatRow",nullptr,SelectChatRow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pressSend",nullptr,PressSend,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"isWeChatInUse",nullptr,WeChatInUse,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopWeChatActivityMonitor",nullptr,StopWeChatActivityMonitor,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"frontmostPID",nullptr,FrontmostPID,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"restoreFocus",nullptr,RestoreFocus,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"revealWeChatWindow",nullptr,RevealWeChatWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"parkWeChatWindow",nullptr,ParkWeChatWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"capture",nullptr,Capture,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"screenTrusted",nullptr,ScreenTrusted,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"requestScreen",nullptr,RequestScreen,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"inspect",nullptr,Inspect,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"inspectSocial",nullptr,InspectSocial,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"writeMoment",nullptr,WriteMoment,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"isTrusted",nullptr,Trusted,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"focus",nullptr,Focus,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"clickInput",nullptr,Click,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"typeChunk",nullptr,Type,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"commit",nullptr,Commit,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods);return exports;
}
}
NAPI_MODULE(huixiang_mac_control,Init)
