const crypto = require('node:crypto');

const DEFAULT_CALIBRATION = {
  title: { x: .32, y: .015, w: .64, h: .095 },
  messages: { x: .31, y: .12, w: .67, h: .64 },
  composer: { x: .32, y: .79, w: .64, h: .16 },
  input: { x: .52, y: .88 }
};
const DEFAULT_SETTINGS = {
  mode: 'assist', interval: 8, expectedTitle: '', windowId: null,
  business: '', model: { baseUrl: '', name: '' },
  rules: { confirmPromises: true, pauseOnActivity: true }, calibration: DEFAULT_CALIBRATION
};
function clean(text) { return String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, ''); }
function within(box, region) {
  const x = box.x + box.w / 2, y = box.y + box.h / 2;
  return x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h;
}
function validRect(r) {
  return r && ['x','y','w','h'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.w >= .03 && r.h >= .02 && r.x+r.w <= 1.001 && r.y+r.h <= 1.001;
}
function validateSettings(input) {
  const mode = input.mode === 'auto' ? 'auto' : 'assist';
  const windowId = input.windowId == null ? null : Number(input.windowId);
  if (windowId !== null && (!Number.isSafeInteger(windowId) || windowId <= 0)) throw new Error('请选择有效的微信窗口');
  const c = input.calibration || DEFAULT_CALIBRATION;
  if (!['title','messages','composer'].every(k=>validRect(c[k])) || !c.input || !['x','y'].every(k=>Number.isFinite(c.input[k])&&c.input[k]>=0&&c.input[k]<=1)) throw new Error('窗口区域超出范围，请重新标记');
  if (!within({x:c.input.x,y:c.input.y,w:0,h:0},c.composer)) throw new Error('输入位置必须在输入框区域内');
  const baseUrl = String(input.model?.baseUrl || '').trim().slice(0,500);
  if (baseUrl) validateEndpoint(baseUrl);
  return {
    mode, interval: Math.max(6,Math.min(60,Number(input.interval)||8)),
    expectedTitle: String(input.expectedTitle || '').trim().slice(0,100),windowId,
    business: String(input.business || '').slice(0,12000),
    model:{baseUrl,name:String(input.model?.name||'').trim().slice(0,150)},
    rules:{confirmPromises:input.rules?.confirmPromises!==false,pauseOnActivity:input.rules?.pauseOnActivity!==false},
    calibration: JSON.parse(JSON.stringify(c))
  };
}
function validateEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Error('模型地址格式不正确'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('模型地址需要 HTTPS；本机模型可以使用 HTTP');
  return url.href.replace(/\/$/,'');
}
function verifyTitle(lines, expected, calibration) {
  const title=String(expected||'').normalize('NFKC').trim();
  if (!title) return false;
  return lines.filter(l=>within(l.box,calibration.title)&&(l.confidence??1)>=.85).some(l=>{
    const seen=l.text.normalize('NFKC').trim();
    return seen===title||seen.replace(/\s*\(\d+\)\s*$/u,'')===title;
  });
}
function parseSnapshot(capture, settings) {
  const region=settings.calibration.messages;
  const all = capture.lines.filter(l=>within(l.box,region)).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
  const messages=[];
  for (const line of all) {
    const text=String(line.text||'').trim();
    if (!text || /^(?:\d{1,2}:\d{2}|今天|昨天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|以下为新消息|以上是打招呼的内容)[\s\d:]*$/u.test(text)) continue;
    const left=(line.box.x-region.x)/region.w;
    const role=(line.confidence??1)<.75?'unknown':line.outgoing?'out':left<.23?'in':'unknown';
    const last=messages.at(-1);
    if(last && last.role===role && line.box.y-last.bottom<.022 && Math.abs(line.box.x-last.x)<.05) {
      last.text+='\n'+text;last.bottom=line.box.y+line.box.h;
    } else messages.push({role,text,x:line.box.x,bottom:line.box.y+line.box.h});
  }
  const canonical=messages.map(({role,text})=>({role,text}));
  return {titleVerified:verifyTitle(capture.lines,settings.expectedTitle,settings.calibration), messages:canonical,
    fingerprint:crypto.createHash('sha256').update(JSON.stringify(canonical.slice(-8))).digest('hex'),
    last:canonical.at(-1)||null, width:capture.width,height:capture.height};
}
function matchFAQ(text, faqs) {
  const target=clean(text);
  if (!target) return null;
  const exact=faqs.filter(f=>f.enabled&&clean(f.question)===target);
  if(exact.length)return exact.length===1?exact[0]:null;
  const candidates=faqs.filter(f=>f.enabled&&f.keywords?.some(k=>clean(k).length>=2&&target.includes(clean(k))));
  return candidates.length===1 ? candidates[0] : null;
}
function requiresConfirmation(text,settings) {
  return settings.rules.confirmPromises && /价格|报价|多少钱|退款|退钱|退押|押金|合同|赔偿|优惠|保证|库存|房源|养[猫狗宠]|转账|付款|账号|验证码|price|refund|contract|payment/iu.test(text);
}
function planReply(snapshot, settings, faqs) {
  if(!snapshot.titleVerified) return {kind:'blocked',reason:'当前会话名称不匹配，接待已停止。'};
  if(snapshot.last?.role!=='in') return {kind:'idle',reason:'等待新的客户消息'};
  const faq=matchFAQ(snapshot.last.text,faqs);
  if(!faq) return {kind:'review',reason:'资料中没有确定答案，需要你处理。'};
  const canAuto=settings.mode==='auto' && faq.autoSend && !requiresConfirmation(snapshot.last.text+' '+faq.answer,settings);
  return {kind:canAuto?'auto':'draft',text:faq.answer,source:faq.question,reason:canAuto?'命中已授权的常见问答':'请确认草稿后发送'};
}
function validateFAQ(input) {
  const question=String(input.question||'').trim().slice(0,500),answer=String(input.answer||'').trim().slice(0,2000);
  if(!question||!answer) throw new Error('请填写问题和回答');
  return {id:typeof input.id==='string'&&/^[a-zA-Z0-9-]{1,60}$/.test(input.id)?input.id:crypto.randomUUID(),question,answer,
    keywords:(Array.isArray(input.keywords)?input.keywords:String(input.keywords||'').split(/[,，、|]/u)).map(x=>String(x).trim().slice(0,50)).filter(Boolean).slice(0,15),
    enabled:input.enabled!==false,autoSend:input.autoSend===true};
}
module.exports={DEFAULT_SETTINGS,DEFAULT_CALIBRATION,clean,within,validateSettings,validateEndpoint,parseSnapshot,verifyTitle,matchFAQ,planReply,validateFAQ};
