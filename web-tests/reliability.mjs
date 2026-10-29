import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 前端可靠性回归：保存中继续编辑、加密冲突、锁定中解密、账号切换的 AI 缓存、
 * PWA 缓存边界。
 *
 * 前置条件：
 *   - 已启动氢导航本地服务（默认 http://127.0.0.1:8080）
 *   - 允许注册且未配置 SMTP（本地默认如此，注册后直接登录）
 *   - 本机有 google-chrome
 *
 * 用法：BASE=http://127.0.0.1:8080 node web-tests/reliability.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const port = 9400 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'dsh-rel-'));
const chromeBin = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser'].find(
  (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
) || 'google-chrome';
const chrome = spawn(chromeBin, ['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({name, ok:Boolean(ok), detail}); console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' — '+detail:''}`); };

async function connect(url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, {resolve, reject}); ws.send(JSON.stringify({id:n, method, params})); });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  await send('Page.enable'); await send('Runtime.enable');
  const evaluate = async (expression) => {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
      if (r.exceptionDetails) return { error: JSON.stringify(r.exceptionDetails.exception) };
      return { value: r.result.value };
    } catch (e) { return { error: String(e) }; }
  };
  return { ws, send, on, evaluate };
}

async function main() {
  for (let i=0;i<80;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{} await sleep(100);}
  const tab1 = await connect(BASE + '/');
  await sleep(2200);

  // ---------- A. workspace save race ----------
  const emailA = `race-${Date.now()}@example.com`;
  const setupA = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('account-btn').click(); await sleep(200);
    document.querySelector('[data-auth-view="register"]').click(); await sleep(80);
    document.getElementById('register-email').value=${JSON.stringify(emailA)};
    document.getElementById('register-password').value='correct horse battery';
    document.getElementById('register-password2').value='correct horse battery';
    document.getElementById('register-form').requestSubmit();
    for(let i=0;i<60;i++){await sleep(100);if(!document.getElementById('account-user').hidden)break;}
    for(let i=0;i<60;i++){await sleep(100);if(document.getElementById('sync-badge').dataset.status==='synced')break;}
    return document.getElementById('sync-badge').dataset.status;})()`);
  check('plaintext account ready', setupA.value === 'synced', setupA.value || setupA.error);

  const hub = await tab1.evaluate(`JSON.stringify((()=>{const d=document.getElementById('hub-dialog');const active=document.querySelector('[data-hub-tab].is-active');return {open:d.open,tab:active&&active.dataset.hubTab,title:document.getElementById('hub-panel-title').textContent};})())`);
  const hubInfo = JSON.parse(hub.value || '{}');
  check('account and settings share one centered hub', hubInfo.open === true && hubInfo.tab === 'account', hub.value);
  await tab1.evaluate(`document.getElementById('hub-dialog').close(); true`);

  // B2：自定义搜索引擎必须能从菜单里被选中并生效。
  const customEngine = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('settings-btn').click(); await sleep(300);
    document.querySelector('[data-hub-tab="search"]').click(); await sleep(200);
    document.getElementById('engine-add-open').click(); await sleep(200);
    document.getElementById('engine-new-name').value='站内搜索';
    document.getElementById('engine-new-bang').value='site';
    document.getElementById('engine-new-url').value='https://example.com/search?q={query}';
    document.getElementById('engine-add-btn').click();
    await sleep(300);
    document.getElementById('hub-dialog').close(); await sleep(150);
    document.getElementById('engine-btn').click(); await sleep(150);
    const option=[...document.querySelectorAll('#engine-menu [data-engine]')].find((node)=>node.textContent.includes('站内搜索'));
    if(option) option.click();
    await sleep(200);
    return JSON.stringify({label:document.getElementById('engine-name').textContent, found:Boolean(option), selected:option?option.getAttribute('aria-selected'):null});})()`);
  const customEngineInfo = JSON.parse(customEngine.value || '{}');
  check('custom search engine can be selected from the menu', customEngineInfo.found === true && customEngineInfo.label === '站内搜索' && customEngineInfo.selected === 'true', customEngine.value);

  const avatar = await tab1.evaluate(`JSON.stringify((()=>{const m=document.getElementById('account-avatar-mini');return {text:m.textContent.trim(),art:!!m.querySelector('.avatar-art'),index:m.dataset.avatar};})())`);
  const avatarInfo = JSON.parse(avatar.value || '{}');
  check('account avatar comes from the DiceBear library', avatarInfo.text === '' && avatarInfo.art === true && /^\d+$/.test(avatarInfo.index || '') && Number(avatarInfo.index) < 24, avatar.value);

  const engineIcon = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('ai-mode-btn').click(); await sleep(180);
    const option=document.querySelector('[data-web-engine="baidu"]');
    if(option) option.click();
    await sleep(1200);
    const img=document.getElementById('ai-mode-favicon');
    return JSON.stringify({label:document.getElementById('ai-mode-name').textContent, src:img.src, hidden:img.hidden, naturalWidth:img.naturalWidth, letter:document.getElementById('ai-mode-letter').textContent});})()`);
  const engineInfo = JSON.parse(engineIcon.value || '{}');
  check('engine mode icon follows the selected search engine', (engineInfo.label || '').includes('百度') && (engineInfo.src || '').includes('baidu.com') && engineInfo.naturalWidth > 0, engineIcon.value);

  await tab1.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/workspace', requestStage: 'Request' }] });
  let putCount = 0;
  tab1.on('Fetch.requestPaused', async (params) => {
    if (params.request.method === 'PUT') {
      putCount += 1;
      setTimeout(() => { tab1.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {}); }, 1400);
    } else {
      tab1.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    }
  });

  const addLink = (title, url) => `(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('add-link-btn').click(); await sleep(120);
    document.getElementById('link-title').value=${JSON.stringify(title)};
    document.getElementById('link-url').value=${JSON.stringify(url)};
    document.getElementById('link-form').requestSubmit(); await sleep(200); return true;})()`;

  await tab1.evaluate(addLink('第一条', 'https://example.com/one'));
  await sleep(1300); // PUT is now paused
  const during = await tab1.evaluate(`JSON.stringify({putCount:${putCount}, status:document.getElementById('sync-badge').dataset.status})`);
  await tab1.evaluate(addLink('第二条', 'https://example.com/two'));
  await sleep(5200);

  const raced = await tab1.evaluate(`(async()=>{const data=await (await fetch('/api/v1/workspace')).json();
    return JSON.stringify({putCount:${putCount}, version:data.payload.version, titles:data.payload.groups.flatMap(g=>g.links.map(l=>l.title)), status:document.getElementById('sync-badge').dataset.status});})()`);
  const racedInfo = JSON.parse(raced.value || '{}');
  check('edit during upload is uploaded in a follow-up request', (racedInfo.putCount || 0) >= 2 && racedInfo.titles && racedInfo.titles.includes('第一条') && racedInfo.titles.includes('第二条'), raced.value);
  check('workspace ends in synced state', racedInfo.status === 'synced', racedInfo.status);
  await tab1.send('Fetch.disable');

  // ---------- C. encrypted account + conflict ----------
  const encrypt = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('account-btn').click(); await sleep(250);
    document.getElementById('encryption-enable').click(); await sleep(200);
    document.getElementById('encrypt-password').value='regression-encryption-1';
    document.getElementById('encrypt-password2').value='regression-encryption-1';
    document.getElementById('encrypt-form').requestSubmit();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('recovery-dialog').open)break;}
    document.getElementById('recovery-confirm').checked=true;
    document.getElementById('recovery-confirm').dispatchEvent(new Event('change'));
    document.getElementById('recovery-continue').click();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('encryption-state').textContent==='已开启')break;}
    await sleep(500);
    document.getElementById('hub-dialog').close();
    return document.getElementById('encryption-state').textContent;})()`);
  check('account encryption enabled', encrypt.value === '已开启', encrypt.value || encrypt.error);

  await tab1.evaluate(addLink('Base', 'https://example.com/base'));
  await sleep(1500);
  const tab2 = await connect(BASE + '/');
  await sleep(2800);
  const tab2ready = await tab2.evaluate(`JSON.stringify({status:document.getElementById('sync-badge').dataset.status,enc:document.getElementById('encryption-state').textContent,unlock:document.getElementById('unlock-dialog').open})`);
  check('second tab unlocks from vault', JSON.parse(tab2ready.value||'{}').enc === '已开启', tab2ready.value);

  await tab1.evaluate(addLink('FromA', 'https://example.com/from-a'));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const state = await tab1.evaluate(`(async()=>({status:document.getElementById('sync-badge').dataset.status,data:await (await fetch('/api/v1/workspace')).json()}))()`);
    const info = state.value || {};
    const titles = info.data && info.data.payload && info.data.payload.groups ? info.data.payload.groups.flatMap(g=>g.links.map(l=>l.title)) : [];
    if (info.status === 'synced' && titles.includes('FromA')) break;
  }
  const tab2edit = await tab2.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('add-link-btn').click(); await sleep(120);
    document.getElementById('link-title').value='FromB';
    document.getElementById('link-url').value='https://example.com/from-b';
    document.getElementById('link-form').requestSubmit();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('merge-dialog').open)break;}
    const mergeOpen=document.getElementById('merge-dialog').open;
    const mergeDiff=document.getElementById('merge-diff').textContent.trim();
    if(mergeOpen){document.querySelector('[data-merge="merge"]').click();}
    for(let i=0;i<100;i++){await sleep(100);if(document.getElementById('sync-badge').dataset.status==='synced')break;}
    const data=await (await fetch('/api/v1/workspace')).json();
    return JSON.stringify({mergeOpen, mergeDiff, enc:document.getElementById('encryption-state').textContent, status:document.getElementById('sync-badge').dataset.status, version:data.payload && data.payload.version, titles:Array.from(document.querySelectorAll('.link-title')).map(n=>n.textContent)});})()`);
  if (tab2edit.error) console.error('tab2 conflict error:', tab2edit.error);
  const conflict = JSON.parse(tab2edit.value || '{}');
  check('conflict dialog appears and merge completes', conflict.mergeOpen === true && conflict.status === 'synced', tab2edit.value);
  check('conflict dialog shows real additions on both sides', (conflict.mergeDiff||'').includes('差异摘要') && (conflict.mergeDiff||'').includes('FromB'), conflict.mergeDiff);
  check('conflict keeps encryption state', conflict.enc === '已开启', String(conflict.enc));
  check('conflict upload remains an encrypted envelope', conflict.version === 3, String(conflict.version));
  check('both sides survive the merge', (conflict.titles||[]).includes('FromA') && (conflict.titles||[]).includes('FromB'), JSON.stringify(conflict.titles));

  // ---------- D. privacy lock during decryption ----------
  const privacy = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('settings-btn').click(); await sleep(400);
    document.querySelector('[data-hub-tab="privacy"]').click(); await sleep(250);
    document.querySelector('[data-hub-subtab="privacy-space"]').click(); await sleep(250);
    document.getElementById('privacy-open-settings').click();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('privacy-lock-dialog').open)break;}
    document.getElementById('privacy-password').value='privacy-regression-1';
    document.getElementById('privacy-password2').value='privacy-regression-1';
    document.getElementById('privacy-lock-form').requestSubmit();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('privacy-recovery-dialog').open)break;}
    document.getElementById('privacy-recovery-confirm').checked=true;
    document.getElementById('privacy-recovery-confirm').dispatchEvent(new Event('change'));
    document.getElementById('privacy-recovery-continue').click();
    for(let i=0;i<80;i++){await sleep(100);if(!document.getElementById('privacy-view').hidden)break;}
    document.getElementById('privacy-lock').click(); await sleep(300);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',altKey:true,shiftKey:true,bubbles:true}));
    await sleep(400);
    document.getElementById('privacy-password').value='privacy-regression-1';
    document.getElementById('privacy-lock-form').requestSubmit();
    QingdhPrivacy.lock('manual');
    await sleep(2200);
    return JSON.stringify({hidden:document.getElementById('privacy-view').hidden, unlocked:QingdhPrivacy.isUnlocked(), groups:document.getElementById('privacy-groups').innerHTML, dialog:document.getElementById('privacy-lock-dialog').open});})()`);
  const privacyInfo = JSON.parse(privacy.value || '{}');
  check('lock during decryption discards the late result', privacyInfo.hidden === true && privacyInfo.unlocked === false && privacyInfo.groups === '' && privacyInfo.dialog === false, privacy.value);

  // ---------- I. PWA cache boundary ----------
  const pwa = await tab1.evaluate(`(async()=>{
    if(!('serviceWorker' in navigator)) return JSON.stringify({supported:false});
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const reg=await Promise.race([navigator.serviceWorker.ready, new Promise((r)=>setTimeout(()=>r(null),8000))]);
    if(!reg) return JSON.stringify({supported:true, ready:false});
    await sleep(500);
    const keys=await caches.keys();
    const cache=keys.length?await caches.open(keys[0]):null;
    return JSON.stringify({
      supported:true, ready:true, keys,
      appCached:cache?Boolean(await cache.match('/app.js', {ignoreSearch:true})):false,
      avatarCached:cache?Boolean(await cache.match('/avatars.js', {ignoreSearch:true})):false,
      apiCached:cache?Boolean(await cache.match('/api/v1/workspace')):false,
      adminCached:cache?Boolean(await cache.match('/admin')):false,
    });})()`);
  const pwaInfo = JSON.parse(pwa.value || '{}');
  check('PWA shell uses the versioned cache', pwaInfo.ready === true && (pwaInfo.keys || []).some((key) => key.startsWith('qingdh-shell-')), JSON.stringify(pwaInfo.keys));
  check('PWA caches shell but never API/admin', pwaInfo.appCached === true && pwaInfo.avatarCached === true && pwaInfo.apiCached === false && pwaInfo.adminCached === false, JSON.stringify({app:pwaInfo.appCached,avatar:pwaInfo.avatarCached,api:pwaInfo.apiCached,admin:pwaInfo.adminCached}));

  // ---------- H2. memo flush, list update and search ----------
  const memo = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.getElementById('memo-nav').click(); await sleep(700);
    document.getElementById('memo-new').click(); await sleep(200);
    const title=document.getElementById('memo-title');
    const body=document.getElementById('memo-body');
    title.value='Hot memo'; title.dispatchEvent(new Event('input',{bubbles:true}));
    body.value='first line\\nsecond line'; body.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(900);
    const before=QingdhSecrets.getCached('memo');
    body.value += '\\nflush-tail';
    body.dispatchEvent(new Event('input',{bubbles:true}));
    window.dispatchEvent(new Event('pagehide'));
    await sleep(900);
    const afterEntry=QingdhSecrets.getCached('memo');
    const after=afterEntry && afterEntry.plain;
    const flushSaved=Boolean(after && after.memos && after.memos.some((m)=>String(m.body||'').includes('flush-tail')));
    const search=document.getElementById('memo-search');
    search.value='Hot'; search.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(100);
    const visible=Array.from(document.querySelectorAll('#memo-list .memo-item')).length;
    QingdhMemo.close();
    return JSON.stringify({loaded:Boolean(before), flushSaved, visible});})()`);
  const memoInfo = JSON.parse(memo.value || '{}');
  check('memo list/search works after lazy load', memoInfo.loaded === true && memoInfo.visible === 1, memo.value);
  check('pagehide flushes the debounced memo edit', memoInfo.flushSaved === true, memo.value);

  // ---------- B. AI cache is account-scoped ----------
  const ai = await tab1.evaluate(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    await QingdhSecrets.save('ai',{version:1,defaultProvider:'deepseek',providers:[{id:'deepseek',enabled:true,model:'deepseek-chat',apiKey:'sk-account-a'}]});
    QingdhAI.activate(); await sleep(600);
    const label=QingdhAI.activeLabel();
    document.getElementById('account-btn').click(); await sleep(300);
    document.getElementById('logout').click();
    for(let i=0;i<80;i++){await sleep(100);if(document.getElementById('account-guest').hidden===false)break;}
    return JSON.stringify({label, cached:QingdhSecrets.getCached('ai'), active:QingdhAI.activeLabel(), panel:document.getElementById('ai-panel').hidden, unlock:document.getElementById('unlock-dialog').open});})()`);
  const aiInfo = JSON.parse(ai.value || '{}');
  check('AI config loads while logged in', aiInfo.label === 'DeepSeek', aiInfo.label);
  check('logout clears AI config, key cache and panel', aiInfo.cached === null && aiInfo.active === '' && aiInfo.panel === true, ai.value);

  const png = await tab1.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(tmpdir(), 'qingdh-regression-final.png'), Buffer.from(png.data, 'base64'));
  const failures = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length) process.exitCode = 1;
  tab1.ws.close(); tab2.ws.close();
}

try { await main(); } finally { chrome.kill('SIGKILL'); }
