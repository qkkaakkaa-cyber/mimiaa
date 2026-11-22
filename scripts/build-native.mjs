import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(root+'/native/bin',{recursive:true});
execFileSync('swiftc',['-parse-as-library','-O','-target','arm64-apple-macosx14.0',root+'/native/WeChatBridge.swift','-o',root+'/native/bin/HuixiangBridge','-framework','AppKit','-framework','ScreenCaptureKit','-framework','Vision','-framework','ApplicationServices'],{stdio:'inherit'});
execFileSync('codesign',['--force','--sign','-',root+'/native/bin/HuixiangBridge'],{stdio:'inherit'});
console.log('本机微信组件已构建');
