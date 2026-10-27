const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {wavFromPcm}=require('../audio-review');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),origin='https://langsidu-sharing.onrender.com';
const pcm=Buffer.alloc(64000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%200>100?1600:-1600,i);
const wav=wavFromPcm(pcm).toString('base64');
const vision={scene:'咖啡馆',category:'餐饮美食',elements:['咖啡杯'],hints:{words:[['coffee','/ˈkɑːfi/','/ˈkɒfi/','咖啡']],phrases:[],sentences:[]}};
const evaluation={phase:'polish',polished:'I have a coffee.',errors:[{original:'I has',correction:'I have',category:'主谓一致',explanation:'I 使用 have。'}],styleSuggestions:[],keywords:[],keyInformation:[],targetMinWords:1,targetMaxWords:104};
async function setup(browser,mode='unsupported'){
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({wav,mode})=>{
  localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}}));
  window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;
  if(mode==='throwing')window.SpeechRecognition=class{start(){throw Error('service unavailable');}stop(){}abort(){}};
  if(mode==='interim')window.SpeechRecognition=class{start(){this.onstart?.();this.onresult?.({resultIndex:0,results:[Object.assign([{transcript:'I has a coffee.'}],{isFinal:false})]});}stop(){this.onend?.();}abort(){}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  window.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){this.mimeType='audio/wav';this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([Uint8Array.from(atob(wav),c=>c.charCodeAt(0))],{type:'audio/wav'})});this.onstop?.();}};
 },{wav,mode});
 await page.route('**/*',r=>r.abort());await page.route(origin+'/',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.route('**/api/practice-usage',r=>r.fulfill({json:{used:{vision:0,speech:0},limits:{vision:20,speech:20}}}));
 await page.route('**/api/analyze-image',r=>r.fulfill({json:vision}));
 await page.route('**/api/transcription/config',r=>r.fulfill({json:{enabled:true,minSeconds:1,maxSeconds:180}}));
 await page.route('**/api/analyze-speech/jobs',r=>r.fulfill({status:202,json:{jobId:'polish'}}));
 await page.route('**/api/analyze-speech/jobs/polish',r=>r.fulfill({json:{status:'complete',result:evaluation}}));
 await page.goto(origin+'/');await page.locator('[data-nav="now"]').click();await page.locator('[data-mode="upload"]').click();
 const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=20;return c.toDataURL().split(',')[1];});
 await page.locator('#photoInput').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});await page.locator('#recognizeImageBtn').click();await page.locator('#recordingSection').waitFor({state:'visible'});
 return {page,errors};
}
async function recordFirst(page){await page.locator('#startRecordBtn').click();await page.locator('#stopRecordBtn').click();await page.waitForFunction(()=>!document.getElementById('firstTranscriptionBtn').disabled&&!document.getElementById('transcriptEditArea').classList.contains('hidden'));}
(async()=>{const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});try{
 for(const mode of ['unsupported','throwing','interim']){
  const {page,errors}=await setup(browser,mode);let calls=0,failed=true,loseResponse=false;const requests=[];
  await page.route('**/api/transcription/jobs',r=>{calls++;const body=r.request().postDataJSON();requests.push(body);assert.equal(body.consent,true);assert.match(body.audio,/^data:audio\/pcm;rate=16000;channels=1;base64,/);assert.equal(body.reference,undefined);assert.equal(body.text,undefined);assert.equal(body.accent,'英式');if(loseResponse)return r.abort('connectionfailed');return r.fulfill({status:202,json:{jobId:body.requestId}});});
  await page.route('**/api/transcription/jobs/*',r=>r.fulfill({json:failed?{status:'failed',code:'TRANSCRIPTION_PROVIDER_ERROR',error:'转写服务暂时繁忙'}:{status:'complete',result:{text:'I has a coffee.',needsReview:true}}}));
  await recordFirst(page);assert.ok(await page.locator('#playbackAudio').getAttribute('src'));assert.equal(await page.locator('#transcriptEdit').inputValue(),mode==='interim'?'I has a coffee.':'');
  await page.locator('#transcriptEdit').fill('My own text.');const audio=await page.locator('#playbackAudio').getAttribute('src');
  await page.locator('#firstTranscriptionBtn').click();await page.waitForFunction(()=>document.getElementById('firstTranscriptionStatus').textContent.includes('已有文字均保留'));
  assert.equal(await page.locator('#transcriptEdit').inputValue(),'My own text.');assert.equal(await page.locator('#playbackAudio').getAttribute('src'),audio);
  failed=false;loseResponse=true;await page.locator('#firstTranscriptionBtn').click();await page.waitForFunction(()=>document.getElementById('firstTranscriptionStatus').textContent.startsWith('转写完成'));
  assert.equal(await page.locator('#transcriptEdit').inputValue(),'I has a coffee.');assert.equal(calls,2);assert.notEqual(requests[0].requestId,requests[1].requestId,'explicit retry after terminal failure uses a new task');
  await page.locator('#confirmTranscriptBtn').click();await page.locator('#rereadSection').waitFor({state:'visible'});assert.equal(await page.locator('#scorePanel').isVisible(),false);
  await page.locator('#startRereadBtn').click();await page.locator('#stopRereadBtn').click();await page.waitForFunction(()=>!document.getElementById('rereadTranscript').readOnly);
  if(mode!=='interim')assert.equal(await page.locator('#rereadTranscript').inputValue(),'','never substitute polished script for actual second recording');
  await page.locator('#rereadTranscriptionBtn').click();await page.waitForFunction(()=>document.getElementById('rereadTranscriptionStatus').textContent.startsWith('转写完成'));
  assert.equal(await page.locator('#rereadTranscript').inputValue(),'I has a coffee.');assert.equal(await page.locator('#playbackAudio').getAttribute('src'),audio);assert.ok(await page.locator('#secondComparisonAudio').getAttribute('src'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await page.close();console.log('PASS both recording rounds, real browser WAV decoding, failure preservation and lost submission recovery:',mode);
 }
 const {page,errors}=await setup(browser);let pending=true,posts=0;
 await page.route('**/api/transcription/jobs',r=>{posts++;return r.fulfill({status:202,json:{jobId:r.request().postDataJSON().requestId}});});
 await page.route('**/api/transcription/jobs/*',r=>r.fulfill({json:pending?{status:'pending'}:{status:'complete',result:{text:'Cloud text.'}}}));
 await recordFirst(page);await page.locator('#firstTranscriptionBtn').click();await page.waitForFunction(()=>document.getElementById('firstTranscriptionStatus').textContent.includes('已等待'));
 await page.locator('#transcriptEdit').fill('Keep my edit.');pending=false;await page.waitForFunction(()=>document.getElementById('firstTranscriptionStatus').textContent.includes('保留你的输入'));
 assert.equal(await page.locator('#transcriptEdit').inputValue(),'Keep my edit.');
 pending=true;await page.locator('#firstTranscriptionBtn').click();await page.waitForFunction(()=>document.getElementById('firstTranscriptionStatus').textContent.includes('已等待'));
 await recordFirst(page);pending=false;await page.waitForTimeout(1800);assert.equal(await page.locator('#transcriptEdit').inputValue(),'','old cloud result must not overwrite a new recording');assert.deepEqual(errors,[]);await page.close();
 console.log('PASS concurrent manual edits and new recordings cannot be overwritten by late transcription');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
