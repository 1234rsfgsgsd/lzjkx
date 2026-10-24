const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const scenes=require('../scene-library');
const origin='https://langsidu-sharing.onrender.com';
const usage={used:{scene:0,vision:0,speech:0},limits:{scene:6,vision:20,speech:20},scope:'当前浏览器；同一网络另有共享上限。服务重新部署时可能重置。'};
(async()=>{
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}}));
   Object.defineProperty(navigator,'storage',{value:{persisted:async()=>false}});
 });
 let generationPosts=0,visionPosts=0,visionPayload,visionMode='success',sceneMode='pending';
 await page.route('**/*',r=>r.abort());
 await page.route(origin+'/',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.route('**/api/practice-usage',r=>r.fulfill({json:usage}));
 await page.route('**/api/scene-library',r=>r.fulfill({json:{scenes}}));
 await page.route('**/api/analyze-image',r=>{visionPosts++;visionPayload=r.request().postDataJSON();return r.fulfill({status:202,json:{jobId:visionPayload.requestId}});});
 await page.route('**/api/analyze-image/jobs/*',r=>r.fulfill({json:visionMode==='pending'?{status:'pending'}:visionMode==='balance'?{status:'failed',code:'AI_BALANCE_INSUFFICIENT',retryable:false,error:'AI 服务额度不足，请联系网站管理员补充额度。可使用免费场景图库。'}:{status:'complete',result:{elements:['杯子','菜单'],likelyIntent:visionPayload.intent||'点单',hints:{words:[['price','/praɪs/','/praɪs/','价格']],phrases:[],sentences:[]},qualityOk:true,sceneMatch:true}}}));
 await page.route('**/api/generate-scene/jobs',r=>{generationPosts++;return r.fulfill({status:202,json:{jobId:'scene'}});});
 let image;
 await page.route('**/api/generate-scene/jobs/scene',r=>r.fulfill({json:sceneMode==='pending'?{status:'pending'}:sceneMode==='balance'?{status:'failed',code:'AI_BALANCE_INSUFFICIENT',retryable:false,error:'AI 服务额度不足，请联系网站管理员补充额度。可使用免费场景图库。'}:{status:'complete',result:{image}}}));
 await page.goto(origin+'/');await page.locator('[data-nav="now"]').click();
 await page.locator('.practice-library summary').click();await page.locator('.free-scene').first().waitFor();
 assert.equal(await page.locator('.free-scene').count(),3);
 for(let i=0;i<3;i++){
   await page.locator('.free-scene').nth(i).click();
   await page.waitForFunction(()=>document.getElementById('imageHintsStatus').textContent.includes('人工整理'));
   assert.match(await page.locator('#photoPreview').getAttribute('src'),/^data:image\/jpeg;base64,/);
   assert.equal(await page.locator('#recordingSection').isVisible(),true);
 }
 assert.equal(visionPosts,0);assert.equal(generationPosts,0);image=await page.locator('#photoPreview').getAttribute('src');
 assert.match(await page.locator('#practiceUsage').innerText(),/图片生成 0 \/ 6/);
 await page.locator('#speakingIntent').fill('想聊遛狗时如何与邻居打招呼');await page.locator('#applyIntentBtn').click();
 await page.waitForFunction(()=>document.getElementById('intentStatus').textContent.includes('词句已更新'));
 assert.equal(visionPayload.intent,'想聊遛狗时如何与邻居打招呼');assert.match(visionPayload.image,/^data:image\/jpeg/);assert.equal(visionPosts,1);
 const before=await page.locator('#hintList').innerText();visionMode='balance';
 await page.locator('#speakingIntent').fill('询问宠物的年龄');await page.locator('#applyIntentBtn').click();
 await page.waitForFunction(()=>document.getElementById('intentStatus').textContent.includes('更新未完成'));
 assert.equal(await page.locator('#hintList').innerText(),before);assert.equal(await page.locator('#retryHintsBtn').isVisible(),false);assert.equal(visionPosts,2);
 await page.locator('#backToEntryBtn').click();await page.locator('[data-mode="generate"]').click();
 await page.locator('#categoryGrid [data-category="餐饮美食"]').click();
 const card=page.locator('#sceneGenerationFeedback');await page.locator('#cancelSceneWaitBtn').waitFor({state:'visible'});
 const box=await card.boundingBox();assert.ok(Math.abs(box.x+box.width/2-width/2)<3);assert.ok(Math.abs(box.y+box.height/2-450)<3);
 assert.equal(await page.locator('#stageImage').getAttribute('data-state'),'active');
 await page.waitForTimeout(1100);assert.match(await page.locator('#sceneElapsed').innerText(),/已等待 [1-9]/);
 if(process.env.PRACTICE_SCREENSHOT_DIR)await card.screenshot({path:path.join(process.env.PRACTICE_SCREENSHOT_DIR,'practice-wait-'+width+'.png')});
 await page.locator('#cancelSceneWaitBtn').click();assert.equal(await card.getAttribute('data-waiting'),null);
 assert.match(await page.locator('#sceneGenerationStatus').innerText(),/已取消等待/);assert.equal(await page.locator('#categoryGrid').getAttribute('aria-busy'),null);
 sceneMode='success';visionMode='pending';await page.locator('#categoryGrid [data-category="学习校园"]').click();
 await page.waitForFunction(()=>document.getElementById('stageAnalysis').dataset.state==='active');
 assert.equal(await page.locator('#stageImage').getAttribute('data-state'),'done');await page.locator('#cancelSceneWaitBtn').click();
 sceneMode='balance';await page.locator('#backToEntryBtn').click();await page.locator('[data-mode="generate"]').click();await page.locator('#categoryGrid [data-category="学习校园"]').click();
 await page.waitForFunction(()=>document.getElementById('sceneGenerationStatus').textContent.includes('额度不足'));
 assert.doesNotMatch(await page.locator('#sceneGenerationStatus').innerText(),/点击“换一个”/);assert.equal(await card.getAttribute('data-waiting'),null);
 assert.equal(generationPosts,3);
 await page.locator('[data-nav="past"]').click();assert.match(await page.locator('#historyStorageSummary').innerText(),/0 条/);
 await page.locator('#requestStorageBtn').click();assert.match(await page.locator('#storagePersistenceStatus').innerText(),/不提供持久存储/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('[data-nav="now"]').click();
 await page.locator('.free-scene').first().click();await page.waitForFunction(()=>document.getElementById('imageHintsStatus').textContent.includes('人工整理'));
 if(process.env.PRACTICE_SCREENSHOT_DIR){await page.screenshot({path:path.join(process.env.PRACTICE_SCREENSHOT_DIR,'practice-'+width+'.png'),fullPage:true});}
 assert.deepEqual(errors,[]);console.log('PASS practice improvements',width,'free scenes, intent/preserve-on-error, quota, stages, elapsed, cancellation, 402 no retry, storage, responsive');await page.close();
}
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
