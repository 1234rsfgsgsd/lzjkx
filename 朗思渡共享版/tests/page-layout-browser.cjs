const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture,registration,record}=require('./cloud-fixture.cjs');

(async()=>{
 const app=await fixture();
 const browser=await chromium.launch({headless:true});
 const out=process.env.PAGE_SCREENSHOTS||path.join(require('node:os').tmpdir(),'langsidu-pages');await fs.mkdir(out,{recursive:true});
 const errors=[];
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const user=await app.request('/api/auth/register',{method:'POST',body:registration('页面检查')});
  const [cookieName,...cookieValue]=user.cookie.split(';')[0].split('=');
  await context.addCookies([{name:cookieName,value:cookieValue.join('='),url:app.origin}]);
  await page.goto(app.origin);await page.locator('#welcomeOverlay').waitFor({state:'hidden'});
  const view=async expected=>{
    assert.equal(await page.locator('[data-app-view]:visible').count(),1);
    assert.equal(await page.locator('[data-app-view]:visible').getAttribute('data-app-view'),expected);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  };
  await view('now/home');
  await page.locator('[data-mode="gallery"]').click();await view('now/themes');
  await page.goBack();await view('now/home');await page.goForward();await view('now/themes');
  await page.locator('[data-nav="me"]').click();await view('me/home');
  assert.equal(await page.locator('#meHomeAccount').innerText(),'账号：页面检查');
  await page.screenshot({path:path.join(out,'me-390.png')});
  await page.getByRole('button',{name:'学习偏好',exact:true}).click();await view('me/preferences');
  await page.locator('#meAccentBubbles').getByText('美式',{exact:true}).click();await page.locator('#savePrefsBtn').click();
  await page.waitForFunction(()=>document.getElementById('accountSyncStatus').textContent==='偏好已保存到云端');
  await page.goBack();await view('me/home');
  await page.getByRole('button',{name:'网站主题颜色',exact:true}).click();await view('me/colors');
  await page.goBack();await page.getByRole('button',{name:'小狼的小窝',exact:true}).click();await view('me/den');
  await page.goBack();await page.getByRole('button',{name:'其他设置',exact:true}).click();await view('me/settings');
  await page.getByRole('button',{name:'记录管理与备份'}).click();await view('past/tools');
  const sampleImage='data:image/png;base64,'+(await fs.readFile(path.join(__dirname,'../assets/wolf-mascot.png'))).toString('base64');
  const records=[{...record(1),image:sampleImage,time:'2026/11/5 23:50:00',sceneName:'咖啡馆点单'},
   {...record(2),time:'2026/11/6 00:10:00',sceneName:'校园交流'},
   {...record(3),time:'2024/2/29 12:00:00',sceneName:'闰日练习'},
   {...record(4),time:'旧记录',sceneName:'<img src=x onerror=alert(1)>'}];
  await page.locator('#historyFileInput').setInputFiles({name:'records.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'langsidu-history',version:1,records}))});
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('新增 4'));
  await page.locator('[data-nav="past"]').click();await view('past/home');assert.equal(await page.locator('.history-item').count(),4);
  await page.locator('#calendarMonthToggle').click();
  // Screenshots should show settled feedback rather than a transient save toast.
  await page.waitForTimeout(2100);
  await page.locator('#calendarGrid [data-date="2026-11-05"]').click();assert.equal(await page.locator('.history-item').count(),1);
  assert.match(await page.locator('.history-item').innerText(),/咖啡馆/);
  assert.equal(await page.locator('#calendarWeek [data-date="2026-11-05"]').getAttribute('aria-pressed'),'true');
  await page.locator('#calendarMonthToggle').click();
  for(const width of [320,390,1280]){
   await page.setViewportSize({width,height:844});await view('past/home');
   await page.screenshot({path:path.join(out,'past-'+width+'.png'),fullPage:true});
  }
  await page.locator('[data-history-open]').click();await view('past/detail');
  assert.equal(await page.locator('#recordDetailContent audio').count(),2);
  assert.match(await page.locator('#recordDetailContent').innerText(),/I has coffee/);
  await page.goBack();await view('past/home');assert.equal(await page.locator('.history-item').count(),1,'date filter survives returning from a record');
  await page.locator('#calendarGrid').waitFor({state:'hidden'});
  await page.locator('#calendarMonthToggle').click();await page.locator('#calendarGrid [data-date="2026-11-07"]').click();
  assert.equal(await page.locator('.history-item').count(),0);assert.equal(await page.locator('#historyEmpty').isVisible(),true);
  await page.locator('#calendarAll').click();assert.equal(await page.locator('.history-item').count(),4,'undated legacy records remain accessible');
  await page.locator('#historySearchToggle').click();await page.locator('#historySearch').fill('校园');assert.equal(await page.locator('.history-item').count(),1);
  await page.locator('#historySearch').fill('img src');assert.equal(await page.locator('.history-item').count(),1);assert.equal(await page.locator('.history-item img[src="x"]').count(),0,'record names are escaped');
  await page.locator('#calendarAll').click();
  // Navigate across years and a leap month, retaining the date-to-record mapping.
  for(let i=0;i<33;i++)await page.locator('#calendarPrev').click();
  assert.match(await page.locator('#calendarMonthToggle').innerText(),/Feb 2024/);
  await page.locator('#calendarGrid [data-date="2024-02-29"]').click();assert.equal(await page.locator('.history-item').count(),1);
  assert.match(await page.locator('.history-item').innerText(),/闰日/);
  await page.locator('#calendarAll').click();await page.locator('[data-nav="me"]').click();
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await view('me/home');await page.screenshot({path:path.join(out,'me-'+width+'.png'),fullPage:true});}
  const bob=await app.request('/api/auth/register',{method:'POST',body:registration('另一个用户')});
  const privateHistory=await app.request('/api/account/history',{cookie:bob.cookie.split(';')[0]});assert.equal(privateHistory.data.records.length,0);
  assert.deepEqual(errors,[]);
  console.log('PASS page routing, browser back/forward, private cloud account, preference save, calendar/date/search/detail, leap year, escaped names, responsive layout');
  console.log('Screenshots:',out);await context.close();
 }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
