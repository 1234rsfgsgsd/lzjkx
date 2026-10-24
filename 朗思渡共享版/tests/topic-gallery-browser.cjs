// All gallery images in this test are made in memory and never enter gallery/.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='https://langsidu-sharing.onrender.com';
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const names=require('../gallery/manifest.json').themes.map(item=>item.name);
const vision={scene:'咖啡馆点单',category:'餐饮美食',elements:['咖啡杯','菜单'],likelyIntent:'点一杯咖啡',hints:{words:[['coffee','/ˈkɑːfi/','/ˈkɒfi/','咖啡']],phrases:[],sentences:[]}};
const waitReady=page=>page.waitForFunction(()=>document.getElementById('imageHintsStatus').textContent.includes('实际图片'));
async function setup(browser,width){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}}));window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;});
  await page.route('**/*',r=>r.abort());
  await page.route(origin+'/',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.route('**/api/practice-usage',r=>r.fulfill({json:{used:{vision:0,speech:0},limits:{vision:20,speech:20},scope:'当前浏览器'}}));
  await page.route('**/api/gallery',r=>r.fulfill({json:{themes:names.map(name=>({name,count:0}))}}));
  await page.goto(origin+'/');await page.locator('[data-nav="now"]').click();
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=80;c.height=60;const ctx=c.getContext('2d');ctx.fillStyle='#72abd5';ctx.fillRect(0,0,80,60);return c.toDataURL('image/png');});
  return {page,image,errors};
}
async function upload(page,image){
  await page.locator('[data-mode="upload"]').click();
  await page.locator('#photoInput').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await page.locator('#recognizeImageBtn').click();
  await page.waitForFunction(()=>document.getElementById('hintList').textContent.includes('coffee'));
}
async function unchanged(page,snapshot){
  assert.equal(await page.locator('#photoPreview').getAttribute('src'),snapshot.image);
  assert.equal(await page.locator('#hintList').innerText(),snapshot.hints);
  assert.equal(await page.locator('#manualTranscript').inputValue(),snapshot.text);
}
(async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try{
    for(const width of [1440,390,320]){
      const {page,image,errors}=await setup(browser,width);let selections=0,analyses=0;
      await page.route('**/api/gallery/random?*',r=>{selections++;return r.fulfill({status:404,json:{code:'GALLERY_EMPTY',error:'“餐饮美食”的图库照片还未添加。可以晚点再来，或先上传自己的照片练习。'}});});
      await page.route('**/api/analyze-image',r=>{analyses++;return r.fulfill({json:vision});});
      assert.equal(await page.locator('.practice-library,.free-scene,#sceneStyleSelect,[data-mode="generate"]').count(),0);
      assert.equal(await page.locator('[data-mode="gallery"] .title').innerText(),'随机图片');
      assert.deepEqual(await page.locator('.bottom-nav [data-nav]').allTextContents().then(a=>a.map(s=>s.trim().toLowerCase())),['now','past','me']);
      await page.locator('[data-mode="gallery"]').click();
      assert.equal(await page.locator('#categoryGrid button').count(),12);
      await page.waitForFunction(()=>[...document.querySelectorAll('[data-gallery-count]')].every(e=>e.textContent==='等待添加照片'));
      await page.locator('#categoryGrid [data-category="餐饮美食"]').click();
      await page.waitForFunction(()=>document.getElementById('gallerySelectionStatus').textContent.includes('还未添加'));
      assert.equal(selections,1);assert.equal(analyses,0,'empty gallery must not call vision');
      assert.equal(await page.locator('#gallerySelectionFeedback').getAttribute('data-waiting'),null);
      assert.equal(await page.locator('#categoryGrid').getAttribute('aria-busy'),null);
      assert.match(await page.locator('#galleryAvailability').innerText(),/等待添加/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
      if(process.env.GALLERY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GALLERY_SCREENSHOT_DIR,'gallery-empty-'+width+'.png'),fullPage:true});
      await upload(page,image);assert.equal(analyses,1);assert.equal(await page.locator('#recordingSection').isVisible(),true);
      assert.match(await page.locator('#hintList').innerText(),/kɒfi/);
      assert.deepEqual(errors,[]);await page.close();console.log('PASS empty theme, upload, preserved blue navigation and layout',width);
    }
    {
      const {page,image,errors}=await setup(browser,390);let count=0,selectionFailure=false,visionFailure=false;const selectionRequests=[],visionRequests=[];
      await page.route('**/api/gallery/random?*',r=>{
        selectionRequests.push(new URL(r.request().url()).searchParams);
        return r.fulfill(selectionFailure?{status:503,json:{code:'GALLERY_UNAVAILABLE',error:'照片暂时无法读取'}}:{json:{id:'cafe-'+(++count),name:'咖啡馆照片',category:'餐饮美食',count:2,image}});
      });
      await page.route('**/api/analyze-image',r=>{
        const payload=r.request().postDataJSON();visionRequests.push(payload);
        assert.match(payload.image,/^data:image\/jpeg;base64,/);assert.equal(payload.mode,undefined);
        return r.fulfill(visionFailure?{status:502,json:{error:'视觉服务暂时不可用',retryable:false}}:{json:payload.intent?{...vision,hints:{...vision.hints,words:[['menu','/ˈmenjuː/','/ˈmenjuː/','菜单']]}}:vision});
      });
      await page.locator('[data-mode="gallery"]').click();await page.locator('#categoryGrid [data-category="餐饮美食"]').click();await waitReady(page);
      assert.equal(selectionRequests[0].get('category'),'餐饮美食');assert.equal(visionRequests.length,1);
      assert.match(await page.locator('#photoPreview').getAttribute('src'),/^data:image\/jpeg/);
      await page.locator('#regenerateBtn').click();await page.waitForFunction(()=>document.getElementById('gallerySelectionStatus').textContent.includes('已从'));await waitReady(page);
      assert.equal(selectionRequests[1].get('category'),'餐饮美食');assert.equal(selectionRequests[1].get('exclude'),'cafe-1');
      await page.locator('#speakingIntent').fill('想问菜单上的饮品');await page.locator('#applyIntentBtn').click();
      await page.waitForFunction(()=>document.getElementById('intentStatus').textContent.includes('词句已更新'));
      assert.equal(visionRequests.at(-1).intent,'想问菜单上的饮品');assert.match(await page.locator('#hintList').innerText(),/menu/);
      await page.locator('#noHintsBtn').click();await page.locator('#needHintsBtn').click();assert.match(await page.locator('#hintList').innerText(),/menu/,'latest intended vocabulary must survive toggle');
      await page.locator('#manualTranscript').fill('I would like to see the menu.');
      const snapshot={image:await page.locator('#photoPreview').getAttribute('src'),hints:await page.locator('#hintList').innerText(),text:await page.locator('#manualTranscript').inputValue()};
      visionFailure=true;await page.locator('#applyIntentBtn').click();await page.waitForFunction(()=>document.getElementById('intentStatus').textContent.includes('更新未完成'));await unchanged(page,snapshot);
      selectionFailure=true;await page.locator('#regenerateBtn').click();await page.waitForFunction(()=>document.getElementById('gallerySelectionStatus').textContent.includes('取图失败'));await unchanged(page,snapshot);
      assert.equal(await page.locator('#regenerateBtn').isEnabled(),true);
      selectionFailure=false;await page.locator('#regenerateBtn').click();await page.waitForFunction(()=>!document.getElementById('categoryGrid').hasAttribute('aria-busy')&&document.getElementById('imageHintsStatus').textContent.includes('分析失败'));await page.locator('#retryHintsBtn').waitFor();assert.equal(await page.locator('#photoSection').isVisible(),true);
      visionFailure=false;await page.locator('#retryHintsBtn').click();await waitReady(page);assert.match(await page.locator('#hintList').innerText(),/coffee/);
      assert.deepEqual(errors,[]);await page.close();console.log('PASS theme-specific selection, exclusion, intent, preserved practice on errors, recognition retry');
    }
    for(const cancelStage of ['selection','analysis']){
      const {page,image,errors}=await setup(browser,390);let release,startedResolve;const started=new Promise(r=>startedResolve=r),gate=new Promise(r=>release=r);let first=true;
      await page.route('**/api/gallery/random?*',async r=>{if(cancelStage==='selection'&&first){first=false;startedResolve();await gate;}return r.fulfill({json:{id:'delayed',name:'咖啡馆照片',category:'餐饮美食',image}});});
      await page.route('**/api/analyze-image',async r=>{if(cancelStage==='analysis'&&first){first=false;startedResolve();await gate;}return r.fulfill({json:vision});});
      await page.locator('[data-mode="gallery"]').click();await page.locator('#categoryGrid [data-category="餐饮美食"]').click();await started;
      const waitCard=page.locator('#gallerySelectionFeedback');assert.equal(await waitCard.getAttribute('data-waiting'),'true');
      const rect=await waitCard.boundingBox();assert.ok(Math.abs(rect.x+rect.width/2-195)<2);assert.ok(Math.abs(rect.y+rect.height/2-450)<3);
      await page.waitForFunction(()=>/已等待 [1-9]/.test(document.getElementById('sceneElapsed').textContent));
      assert.equal(await page.locator(cancelStage==='analysis'?'#stageAnalysis':'#stageImage').getAttribute('data-state'),'active');
      if(process.env.GALLERY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GALLERY_SCREENSHOT_DIR,'gallery-wait-'+cancelStage+'.png')});
      await page.locator('#cancelSceneWaitBtn').click();const stopped=await page.locator('#sceneElapsed').innerText();
      assert.equal(await waitCard.getAttribute('data-waiting'),null);assert.equal(await page.locator('#categoryGrid').getAttribute('aria-busy'),null);
      if(cancelStage==='selection'){
        await page.locator('[data-mode="upload"]').click();release();await upload(page,image);
        assert.equal(await page.locator('#regenerateBtn').isVisible(),false);assert.doesNotMatch(await page.locator('#photoCaption').innerText(),/主题图库/);
      }else{
        assert.equal(await page.locator('#photoSection').isVisible(),true);assert.equal(await page.locator('#retryHintsBtn').isVisible(),true);
        const completed=page.waitForResponse('**/api/analyze-image');release();await completed;
        assert.equal(await page.locator('#hintList').innerText(),'','cancelled response cannot overwrite state');
        await page.locator('#retryHintsBtn').click();await waitReady(page);
      }
      assert.equal(await page.locator('#sceneElapsed').innerText(),stopped,'elapsed timer stops on cancellation');
      assert.deepEqual(errors,[]);await page.close();console.log('PASS centred waiting, time, cancellation and late-response protection',cancelStage);
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
