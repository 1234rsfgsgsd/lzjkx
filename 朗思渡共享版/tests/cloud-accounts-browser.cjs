const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {fixture,registration,record}=require('./cloud-fixture.cjs');

(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'langsidu-browser-db-'));
  const screenshots=process.env.ACCOUNT_SCREENSHOT_DIR||path.join(os.tmpdir(),'langsidu-account-screenshots');await fs.mkdir(screenshots,{recursive:true});
  const app=await fixture({directory});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[];
  const open=async(width=390)=>{
    const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return {context,page};
  };
  const click=async(page,text)=>page.getByRole('button',{name:text,exact:true}).click();
  const heading=async(page,text)=>{await page.waitForFunction(text=>document.getElementById('accountHeading').textContent===text,text);};
  const welcome=async page=>{await page.goto(app.origin);await heading(page,'欢迎来到朗思渡，你的智能英语口语陪练');await click(page,'开始');};
  const fill=async(page,name,password='English123')=>{await page.locator('#accountNickname').fill(name);await page.locator('#accountPassword').fill(password);};
  const ready=async(page)=>{await page.locator('#welcomeOverlay').waitFor({state:'hidden'});assert.equal(await page.locator('.app').evaluate(el=>el.inert),false);};
  const past=async page=>{await page.locator('[data-nav="past"]').click();};
  const upload=async(page,records)=>page.locator('#historyFileInput').setInputFiles({name:'test-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'langsidu-history',version:1,records}))});
  async function centered(page){
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const box=await page.locator('#accountGate').boundingBox();assert.ok(Math.abs(box.x+box.width/2-(await page.evaluate(()=>innerWidth))/2)<2);
    assert.equal(await page.locator('#accountHeading').evaluate(el=>getComputedStyle(el).textAlign),'center');
  }
  async function clear(page,answers){
    const messages=[];
    const handler=dialog=>{messages.push(dialog.message());answers[messages.length-1]?dialog.accept():dialog.dismiss();};
    page.on('dialog',handler);
    try{await page.locator('#clearHistoryBtn').click();}finally{page.off('dialog',handler);}
    assert.deepEqual(messages,answers.map((_,i)=>i?'删除后，所有记录不可找回，是否确认删除？':'是否删除所有记录？'));
  }
  try{
    const a=await open();await welcome(a.page);await centered(a.page);await click(a.page,'还没有账号');
    await heading(a.page,'你想达到怎样的成就？');await centered(a.page);await a.page.screenshot({path:path.join(screenshots,'survey-390.png')});await click(a.page,'旅游');
    await click(a.page,'英式');await heading(a.page,'你的学历水平？');
    for(const width of [320,390,1280]){await a.page.setViewportSize({width,height:900});await centered(a.page);}
    await click(a.page,'高中');await fill(a.page,'Alice');await a.page.locator('#accountConfirmPassword').fill('Different123');await click(a.page,'注册并进入');
    assert.match(await a.page.locator('#accountError').innerText(),/两次输入/);
    await a.page.locator('#accountConfirmPassword').fill('English123');await a.page.screenshot({path:path.join(screenshots,'register-1280.png')});await click(a.page,'注册并进入');await ready(a.page);
    assert.match(await a.page.locator('#nowMeta').innerText(),/高中.*英式/);
    assert.equal(await a.page.evaluate(()=>Object.keys(localStorage).some(k=>localStorage.getItem(k).includes('English123'))),false);
    await past(a.page);await upload(a.page,[record()]);await a.page.locator('.history-item').waitFor();
    assert.equal(await a.page.locator('.history-item audio').count(),2);
    await a.page.reload();await ready(a.page);await past(a.page);await a.page.locator('.history-item').waitFor();
    const b=await open();await welcome(b.page);await click(b.page,'已经注册账号');await fill(b.page,'Alice','Wrong123');await click(b.page,'登录');await b.page.waitForFunction(()=>document.getElementById('accountError').textContent.includes('不正确'));
    await fill(b.page,'Alice');await click(b.page,'登录');await ready(b.page);await past(b.page);await b.page.locator('.history-item').waitFor();assert.equal(await b.page.locator('.history-item audio').first().getAttribute('src'),record().audio);
    await a.page.locator('[data-nav="me"]').click();await a.page.locator('#meNickInput').fill('Alice的新昵称');await click(a.page,'保存昵称与头像');await a.page.waitForFunction(()=>document.getElementById('accountSyncStatus').textContent==='偏好已保存到云端');
    await b.page.reload();await ready(b.page);assert.equal(await b.page.locator('#nowNick').innerText(),'Alice的新昵称');await past(b.page);await b.page.locator('.history-item').waitFor();
    await a.page.route('**/api/account/settings',r=>r.fulfill({status:503,json:{error:'测试网络失败'}}));await a.page.locator('#meNickInput').fill('待同步的昵称');await click(a.page,'保存昵称与头像');await a.page.waitForFunction(()=>document.getElementById('accountSyncStatus').textContent.includes('偏好未保存'));assert.equal(await a.page.locator('#retryAccountSyncBtn').isVisible(),true);
    await a.page.unroute('**/api/account/settings');await click(a.page,'重试保存偏好');await a.page.waitForFunction(()=>document.getElementById('accountSyncStatus').textContent==='偏好已保存到云端');
    const bobReg=await app.request('/api/auth/register',{method:'POST',body:registration('Bob')});assert.equal(bobReg.status,200);
    const c=await open();await welcome(c.page);await click(c.page,'已经注册账号');await fill(c.page,'Bob');await click(c.page,'登录');await ready(c.page);await past(c.page);assert.equal(await c.page.locator('.history-item').count(),0,'other account has no Alice records');
    await upload(c.page,[record(99)]);await c.page.locator('.history-item').waitFor();
    await a.page.evaluate(async item=>{localStorage.setItem('langsidu_state_v5',JSON.stringify({profile:{nick:'旧浏览器昵称'},history:[]}));const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('langsidu_private_history',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put([item],'history');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();},{...record(42),transcript:'These are legacy records.',corrected:'These are legacy records.'});
    await a.page.reload();await ready(a.page);await past(a.page);await a.page.locator('.history-item').waitFor();assert.equal(await a.page.locator('.history-item').count(),1,'legacy records never imported automatically');
    a.page.once('dialog',d=>d.accept());await a.page.locator('#importLocalRecordsBtn').click();await a.page.waitForFunction(()=>document.getElementById('localImportStatus').textContent.includes('已导入 1'));assert.equal(await a.page.locator('.history-item').count(),2);
    // The stale second device retries with the latest revision, preserving both devices' records.
    let conflicts=0;b.page.on('response',response=>{if(response.url().endsWith('/api/account/history')&&response.status()===409)conflicts++;});
    await upload(b.page,[{...record(55),transcript:'A second device record.',corrected:'A second device record.'}]);await b.page.waitForFunction(()=>document.querySelectorAll('.history-item').length===3);assert.equal(conflicts,1,'stale device resolves a real database revision conflict');
    await a.page.locator('[data-nav="now"]').click();await past(a.page);await a.page.waitForFunction(()=>document.querySelectorAll('.history-item').length===3);
    await clear(a.page,[false]);assert.equal(await a.page.locator('.history-item').count(),3);
    await clear(a.page,[true,false]);assert.equal(await a.page.locator('.history-item').count(),3);
    await clear(a.page,[true,true]);await a.page.waitForFunction(()=>document.querySelectorAll('.history-item').length===0);
    await c.page.reload();await ready(c.page);await past(c.page);await c.page.locator('.history-item').waitFor();assert.equal(await c.page.locator('.history-item').count(),1,'clear only affects current account');
    assert.equal(await a.page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('langsidu_private_history',1);r.onsuccess=()=>resolve(r.result);});return new Promise(resolve=>{const tx=db.transaction('records','readonly');const r=tx.objectStore('records').get('history');tx.oncomplete=()=>{db.close();resolve(r.result.length);};});}),1,'legacy source is preserved');
    await a.page.locator('[data-nav="me"]').click();await click(a.page,'退出登录');await heading(a.page,'欢迎来到朗思渡，你的智能英语口语陪练');assert.equal(await a.page.locator('.app').isVisible(),false);
    assert.equal(await a.page.evaluate(()=>JSON.parse(localStorage.getItem('langsidu_state_v5')).profile.nick),'旧浏览器昵称','cloud profile never overwrites guest profile');
    const d=await open(320);await d.page.route('**/api/auth/me',r=>r.fulfill({status:503,json:{error:'测试数据库不可用'}}));await d.page.goto(app.origin);await heading(d.page,'暂时无法连接云端账号');assert.equal(await d.page.locator('.app').isVisible(),false);await centered(d.page);await d.context.close();
    assert.deepEqual(errors,[]);console.log('PASS cloud browser: registration, login, cross-device history/audio, private accounts, explicit legacy import, two deletion confirmations, logout and unavailable-database gate');console.log('Screenshots:',screenshots);
    await a.context.close();await b.context.close();await c.context.close();
  }finally{await browser.close();await app.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
