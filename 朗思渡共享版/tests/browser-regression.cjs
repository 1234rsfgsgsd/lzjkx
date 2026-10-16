// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const origin = 'https://langsidu-sharing.onrender.com';
const success = {
  scene:'桌前阅读', category:'学习校园', likelyIntent:'介绍阅读', elements:['书本','桌子'],
  hints:{words:[['book','/bʊk/','/bʊk/','书']],phrases:[],sentences:[]}
};

(async () => {
  const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  try {
    for (const scenario of ['success', 'retry-network', 'permission']) {
      const page = await browser.newPage();
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式',education:'大学及以上'}}));
        window.SpeechRecognition=undefined; window.webkitSpeechRecognition=undefined;
        window.__spoken=[];
        Object.defineProperty(window,'speechSynthesis',{value:{cancel(){},speak(u){window.__spoken.push({text:u.text,lang:u.lang});}}});
      });
      await page.route('**/*', route => route.abort());
      await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:html}));
      let calls=0;
      await page.route('**/api/analyze-image',async route=>{
        calls++;
        const body=route.request().postDataJSON();
        assert.match(body.image,/^data:image\/jpeg;base64,/);
        if(scenario==='permission') return route.fulfill({status:502,json:{error:'视觉服务拒绝了请求（401）',retryable:false}});
        if(scenario==='retry-network' && calls===1) return route.fulfill({status:502,json:{error:'服务繁忙',retryable:true}});
        if(scenario==='retry-network' && calls===2) return route.abort('connectionfailed');
        await route.fulfill({json:success});
      });
      await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
      await page.locator('[data-nav="now"]').click();
      await page.locator('[data-mode="upload"]').click();
      // A tiny PNG must pass through the same decoding and JPEG normalization as user files.
      const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=16;c.height=16;return c.toDataURL('image/png').split(',')[1];});
      await page.locator('#photoInput').setInputFiles({name:'small.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
      await page.locator('#recognizeImageBtn').click();
      await page.waitForFunction(()=>!document.getElementById('recognizeImageBtn').disabled,null,{timeout:20000});
      if(scenario==='permission') {
        assert.equal(calls,1);
        assert.equal(await page.locator('#uploadStatus').isVisible(),true);
        assert.match(await page.locator('#uploadStatus').innerText(),/401/);
        await page.clock.install(); await page.clock.fastForward(11000);
        assert.equal(await page.locator('#uploadStatus').isVisible(),true,'error must stay visible');
        assert.equal(await page.locator('#pickFileBtn').isVisible(),true,'another upload must remain possible');
      } else {
        assert.equal(calls,scenario==='success'?1:3);
        for(const id of ['photoSection','hintSection','recordingSection','hintList']) assert.equal(await page.locator('#'+id).isVisible(),true,id);
        assert.match(await page.locator('#hintList').innerText(),/book/);
        if(scenario==='success') {
          const longText='I have a book. '.repeat(100);
          await page.route('**/api/analyze-speech/jobs',route=>route.fulfill({status:202,json:{jobId:'test-job'}}));
          await page.route('**/api/analyze-speech/jobs/test-job',route=>route.fulfill({json:{status:'complete',result:{overall:85,grammar:85,vocabulary:85,fluency:85,coherence:85,taskCompletion:85,polished:longText,errors:[],sentences:[]}}}));
          await page.locator('#manualTranscript').fill(longText);
          await page.locator('#submitManualBtn').click();
          await page.locator('#scorePanel').waitFor({state:'visible'});
          assert.match(await page.locator('#scoreOverall').innerText(),/85/);
          assert.ok(await page.locator('#polishedSentences button').count()>1);
          await page.locator('#polishedSentences button').first().click();
          assert.equal(await page.evaluate(()=>window.__spoken[0].lang),'en-GB');
          assert.deepEqual(await page.evaluate(()=>window.__spoken.map(s=>s.text)),['I have a book.']);
          await page.locator('#backToEntryBtn').click();
          await page.locator('[data-mode="generate"]').click();
          await page.locator('#categoryGrid [data-category="学习校园"]').click();
          await page.locator('#photoSection').waitFor({state:'visible'});
          assert.equal(await page.locator('#recordingSection').isVisible(),true,'generated scenes must still work');
        }
      }
      assert.deepEqual(errors,[]);
      console.log('PASS browser',scenario);
      await page.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
