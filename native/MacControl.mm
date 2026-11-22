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
    if(!AXIsProcessTrusted())throw std::runtime_error("回响尚未获得辅助功能权限，请在系统设置中开启");
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
void focus(napi_env env,napi_value params) {
  Target target(env,params);CFTypeRef raw=nullptr;
  if(AXUIElementCopyAttributeValue(target.app,kAXWindowsAttribute,&raw)!=kAXErrorSuccess || !raw || CFGetTypeID(raw)!=CFArrayGetTypeID()) {
    if(raw)CFRelease(raw);throw std::runtime_error("无法定位微信窗口，请检查权限是否生效");
  }
  AXUIElementRef chosen=nullptr;CFArrayRef windows=(CFArrayRef)raw;
  for(CFIndex i=0;i<CFArrayGetCount(windows);i++) {
    AXUIElementRef candidate=(AXUIElementRef)CFArrayGetValueAtIndex(windows,i);
    if(close(bounds(candidate),target.frame)){chosen=candidate;break;}
  }
  if(!chosen){CFRelease(raw);throw std::runtime_error("微信窗口布局已变化，请重新读取");}
  [[NSRunningApplication runningApplicationWithProcessIdentifier:target.pid] activateWithOptions:NSApplicationActivateAllWindows];
  AXError result=AXUIElementPerformAction(chosen,kAXRaiseAction);CFRelease(raw);
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
  CGEventPost(kCGHIDEventTap,down);
  if(hold)std::this_thread::sleep_for(std::chrono::milliseconds((int)hold));
  CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
void type(napi_env env,napi_value params) {
  Target target(env,params);target.assertFocused();std::u16string chars=text(env,params,"text");
  for(char16_t character:chars)if(character<32||character==127)throw std::runtime_error("回复中包含不支持的控制字符");
  CGEventRef down=CGEventCreateKeyboardEvent(nullptr,0,true),up=CGEventCreateKeyboardEvent(nullptr,0,false);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建文字输入事件");}
  CGEventKeyboardSetUnicodeString(down,chars.size(),reinterpret_cast<const UniChar *>(chars.data()));
  CGEventKeyboardSetUnicodeString(up,chars.size(),reinterpret_cast<const UniChar *>(chars.data()));
  CGEventPost(kCGHIDEventTap,down);CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
void commit(napi_env env,napi_value params) {
  Target target(env,params);target.assertFocused();
  CGEventRef down=CGEventCreateKeyboardEvent(nullptr,36,true),up=CGEventCreateKeyboardEvent(nullptr,36,false);
  if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建发送事件");}
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
  if(!AXIsProcessTrusted())throw std::runtime_error("请先为回响开启辅助功能权限");
  NSRunningApplication *running=nil;
  for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)if([@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:app.bundleIdentifier]){running=app;break;}
  if(!running)throw std::runtime_error("请先登录电脑微信");
  AXUIElementRef app=AXUIElementCreateApplication(running.processIdentifier);CFTypeRef windows=nullptr;
  AXUIElementCopyAttributeValue(app,kAXWindowsAttribute,&windows);CFRelease(app);
  NSMutableArray *results=[NSMutableArray array];
  if(windows && CFGetTypeID(windows)==CFArrayGetTypeID())for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)windows);i++){
    AXUIElementRef win=(AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)windows,i);NSMutableArray *items=[NSMutableArray array];int count=0;walk(win,items,0,count);
    BOOL hasSessions=NO;for(NSDictionary *item in items)if([item[@"id"] isEqual:@"session_list"])hasSessions=YES;
    if(!social&&!hasSessions)continue;
    CGRect frame=bounds(win);NSNumber *windowID=nil;
    NSArray *infos=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *entry in infos){CGRect candidate;NSDictionary *box=entry[(id)kCGWindowBounds];if([entry[(id)kCGWindowOwnerPID] intValue]==running.processIdentifier && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)box,&candidate) && close(candidate,frame)){windowID=entry[(id)kCGWindowNumber];break;}}
    if(!windowID)continue;
    [results addObject:@{@"pid":@(running.processIdentifier),@"frame":rectJSON(frame),@"windowId":windowID,@"items":items,@"title":stringAttr(win,kAXTitleAttribute)}];if(!social)break;
  }
  if(windows)CFRelease(windows);
  if(!results.count)throw std::runtime_error(social?"请打开电脑微信":"请展开微信的聊天列表，回响会自动识别");
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

 if(!CGPreflightScreenCaptureAccess()){settleCapture(callback,nil,@"需要为当前回响开启屏幕录制权限");return promise;}
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
AXUIElementRef verifiedChat(Target &target,NSString *expected){
 CFTypeRef windows=nullptr;AXUIElementCopyAttributeValue(target.app,kAXWindowsAttribute,&windows);AXUIElementRef chosen=nullptr;
 if(windows&&CFGetTypeID(windows)==CFArrayGetTypeID())for(CFIndex i=0;i<CFArrayGetCount((CFArrayRef)windows);i++){auto win=(AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)windows,i);if(close(bounds(win),target.frame)){chosen=(AXUIElementRef)CFRetain(win);break;}}
 if(windows)CFRelease(windows);if(!chosen)throw std::runtime_error("微信窗口已变化");
 AXUIElementRef title=findElement(chosen,@"current_chat_name_label",nil);NSString *name=title?stringAttr(title,kAXValueAttribute):@"";
 if(title)CFRelease(title);name=[name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
 NSRegularExpression *count=[NSRegularExpression regularExpressionWithPattern:@"\\s*[（(][0-9]+[)）]\\s*$" options:0 error:nil];name=[count stringByReplacingMatchesInString:name options:0 range:NSMakeRange(0,name.length) withTemplate:@""];
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
void setComposer(napi_env env,napi_value params){
 Target target(env,params);NSString *reply=longString(env,params,"text"),*expected=longString(env,params,"expectedTitle");
 AXUIElementRef win=verifiedChat(target,expected),input=findElement(win,@"chat_input_field",nil);CFRelease(win);
 if(!input)throw std::runtime_error("无法定位微信输入框");
 NSString *existing=stringAttr(input,kAXValueAttribute);if(existing.length){CFRelease(input);throw std::runtime_error("微信已有草稿，保留给你处理");}
 Boolean settable=false;AXUIElementIsAttributeSettable(input,kAXValueAttribute,&settable);
 if(!settable){CFRelease(input);throw std::runtime_error("当前微信不支持后台输入");}
 AXError result=AXUIElementSetAttributeValue(input,kAXValueAttribute,(__bridge CFStringRef)reply);CFRelease(input);
 if(result!=kAXErrorSuccess)throw std::runtime_error("微信拒绝后台输入，已停止本次回复");
}
void pressSend(napi_env env,napi_value params){
 Target target(env,params);NSString *reply=longString(env,params,"text"),*expected=longString(env,params,"expectedTitle");
 AXUIElementRef win=verifiedChat(target,expected),input=findElement(win,@"chat_input_field",nil);
 NSString *existing=input?stringAttr(input,kAXValueAttribute):@"";
 if(input){
  if(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier!=target.pid)AXUIElementSetAttributeValue(input,kAXFocusedAttribute,kCFBooleanTrue);
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
 if(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==target.pid)throw std::runtime_error("你正在使用微信，自动暂停");
 // Deliver Return only to the validated WeChat process. Global keyboard focus
 // and the user's current application are untouched.
 CGEventRef down=CGEventCreateKeyboardEvent(nullptr,36,true),up=CGEventCreateKeyboardEvent(nullptr,36,false);
 if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);throw std::runtime_error("无法创建微信进程发送事件");}
 CGEventSetFlags(down,0);CGEventSetFlags(up,0);
 CGEventPostToPid(target.pid,down);CGEventPostToPid(target.pid,up);CFRelease(down);CFRelease(up);
}
napi_value SetComposer(napi_env e,napi_callback_info i){return run(e,i,setComposer);}
napi_value PressSend(napi_env e,napi_callback_info i){return run(e,i,pressSend);}
napi_value WeChatActive(napi_env env,napi_callback_info i){NSString *id=NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;napi_value value;napi_get_boolean(env,[@[@"com.tencent.xinWeChat",@"com.tencent.WeChat"] containsObject:id],&value);return value;}
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

napi_value Init(napi_env env,napi_value exports){
  napi_property_descriptor methods[]={
    {"setComposer",nullptr,SetComposer,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pressSend",nullptr,PressSend,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"isWeChatActive",nullptr,WeChatActive,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"frontmostPID",nullptr,FrontmostPID,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"restoreFocus",nullptr,RestoreFocus,nullptr,nullptr,nullptr,napi_default,nullptr},
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
