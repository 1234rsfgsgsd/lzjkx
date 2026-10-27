const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {speechReport,textReport}=require('../oral-rubric');const {validateAudio}=require('../xfyun-ise');
const origin='https://langsidu-sharing.onrender.com',html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const vision={scene:'咖啡馆',category:'餐饮美食',elements:['咖啡杯'],hints:{words:[['coffee','/ˈkɑːfi/','/ˈkɒfi/','咖啡']],phrases:[],sentences:[]}};
const polished='I have a coffee. It tastes good.';
const textEvaluation={phase:'final',grammar:80,vocabulary:70,topicRelevance:90,scoreReasons:{grammar:'主谓一致。',vocabulary:'词汇基本准确。',topicRelevance:'主要信息完整。'},errors:[],summary:'文本分析'};
const acoustic={status:'scored',scores:{accuracy:80,fluency:75,integrity:100,total:78},metrics:{wpm:120,durationSeconds:4,alignedWordCount:8,alignedSpeechSeconds:3,longPauseCount:0},words:[{text:'coffee',error:'替换',start:1.2,end:1.8,phones:[]}]};
const audioReview={status:'scored',heardTranscript:'I have a coffee. It tastes good.',dimensions:{prosody:{score:8,confidence:'medium',reason:'句子重点基本清楚',evidence:[{start:1,end:2,observation:'coffee上有明显重音',suggestion:'保持关键词重音'}]},intelligibility:{score:12,confidence:'medium',reason:'大部分容易听懂',evidence:[{start:2,end:3,observation:'句末略轻',suggestion:'保持句末清晰'}]}}};
function wave(frequency){const samples=4*48000,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);for(let i=0;i<samples;i++){const n=Math.round(Math.sin(2*Math.PI*frequency*i/48000)*8000);bytes.writeInt16LE(n,44+i*4);bytes.writeInt16LE(n,46+i*4);}return bytes.toString('base64');}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  for(const scenario of ['speech','quota','disabled','no-transcript','audio-review','review-failure']){
    const page=await browser.newPage({viewport:{width:scenario==='speech'?1280:390,height:900},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({firstWave,secondWave})=>{
      localStorage.setItem('langsidu_state_v5',JSON.stringify({skipWelcome:true,prefs:{accent:'英式'}}));
      const waveList=[firstWave,secondWave];window.__spoken=[];let pass=0,audioPass=0;
      Object.defineProperty(window,'speechSynthesis',{value:{cancel(){},getVoices(){return[];},speak(u){window.__spoken.push({text:u.text,lang:u.lang});setTimeout(()=>u.dispatchEvent(new Event('end')),1);}}});
      window.SpeechRecognition=class{start(){this.onstart?.();const transcript=++pass===1?'I has a coffee.':'I have a coffee. It tastes good.';this.onresult?.({resultIndex:0,results:[Object.assign([{transcript}],{isFinal:true})]});}stop(){this.onend?.();}abort(){}};
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
      window.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/wav';this.wave=waveList[(audioPass++)%2];}start(){this.state='recording';}stop(){this.state='inactive';const bytes=Uint8Array.from(atob(this.wave),c=>c.charCodeAt(0));this.ondataavailable?.({data:new Blob([bytes],{type:'audio/wav'})});this.onstop?.();}};
    },{firstWave:wave(300),secondWave:wave(450)});
    await page.route('**/*',r=>r.abort());await page.route(origin+'/',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.route('**/api/pronunciation/config',r=>r.fulfill({json:{enabled:scenario!=='disabled',maxSeconds:180,minSeconds:3,audioReview:{enabled:['audio-review','review-failure'].includes(scenario)}}}));
    await page.route('**/api/analyze-image',r=>r.fulfill({json:vision}));
    let speechRequest,textRequest,audioPosts=0,audioPolls=0,currentText;
    await page.route('**/api/analyze-speech/jobs',r=>{currentText=r.request().postDataJSON();if(currentText.phase==='final')textRequest=currentText;return r.fulfill({status:202,json:{jobId:'text'}});});
    await page.route('**/api/analyze-speech/jobs/text',r=>r.fulfill({json:{status:'complete',result:currentText.phase==='polish'?{phase:'polish',polished,errors:[{original:'I has',correction:'I have',category:'主谓一致',explanation:'I 使用 have。'}],accent:'英式'}:{...textEvaluation,oralReport:textReport(textEvaluation)}}}));
    await page.route('**/api/pronunciation/jobs',r=>{
      audioPosts++;const payload=r.request().postDataJSON();if(speechRequest)assert.equal(payload.requestId,speechRequest.requestId);speechRequest=payload;
      const input=validateAudio(payload);assert.ok(Math.abs(input.durationSeconds-4)<.02);assert.equal(input.pcm.length,128000);assert.equal(payload.reference,polished);assert.equal(payload.accent,'英式');
      if(scenario==='quota')return r.fulfill({status:429,json:{error:'本站讯飞语音评测调用次数已达上限',code:'XFYUN_CALL_LIMIT',retryable:false}});
      if(audioPosts===1)return r.abort('connectionfailed');
      return r.fulfill({status:202,json:{jobId:'audio'}});
    });
    await page.route('**/api/pronunciation/jobs/audio',r=>{audioPolls++;if(audioPolls===1)return r.fulfill({json:{status:'pending',stage:scenario==='audio-review'?'audio-review':'text'}});return r.fulfill({json:{status:'complete',result:{report:speechReport(acoustic,scenario==='no-transcript'?null:textEvaluation,scenario==='audio-review'?audioReview:null),textEvaluation:scenario==='no-transcript'?null:textEvaluation,textWarning:scenario==='no-transcript'?'没有实际转写，语法、词汇和内容仍待评。':'',audioReviewWarning:scenario==='review-failure'?'百炼音频分析超时；讯飞结果仍保留。':''}}});});
    await page.goto(origin+'/');await page.locator('[data-nav="now"]').click();await page.locator('[data-mode="upload"]').click();
    const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=16;return c.toDataURL('image/png').split(',')[1];});await page.locator('#photoInput').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});await page.locator('#recognizeImageBtn').click();await page.locator('#recordingSection').waitFor();
    await page.locator('#startRecordBtn').click();await page.locator('#stopRecordBtn').click();await page.locator('#transcriptEditArea').waitFor();await page.locator('#confirmTranscriptBtn').click();await page.locator('#rereadSection').waitFor();assert.equal(audioPosts,0);assert.equal(await page.locator('#scorePanel').isVisible(),false);
    const firstAudio=await page.locator('#playbackAudio').getAttribute('src');await page.locator('#startRereadBtn').click();await page.locator('#stopRereadBtn').click();await page.waitForFunction(()=>!document.getElementById('rereadTranscript').readOnly&&document.getElementById('rereadTranscript').value.length>0);
    const secondAudio=await page.locator('#secondComparisonAudio').getAttribute('src');assert.notEqual(secondAudio,firstAudio);
    if(scenario==='no-transcript')await page.locator('#rereadTranscript').fill('');
    assert.equal(await page.locator('#useAudioReview').isChecked(),false,'supplemental audio requires separate consent');
    if(['audio-review','review-failure'].includes(scenario))await page.locator('#useAudioReview').check();
    await page.locator('#scoreRereadBtn').click();
    if(scenario==='quota'){
      await page.waitForFunction(()=>document.getElementById('finalEvaluationProgress').textContent.includes('上限'));assert.equal(audioPosts,1);assert.equal(await page.locator('#oralReportPanel').isVisible(),false);assert.equal(await page.locator('#firstComparisonAudio').getAttribute('src'),firstAudio);assert.equal(await page.locator('#secondComparisonAudio').getAttribute('src'),secondAudio);
      await page.locator('#useAudioAssessment').uncheck();await page.locator('#scoreRereadBtn').click();await page.waitForFunction(()=>document.getElementById('oralReportTitle').textContent.includes('文本分析'));assert.equal(textRequest.rubric,'oral-v1');
    }else if(scenario==='disabled'){
      await page.waitForFunction(()=>document.getElementById('oralReportTitle').textContent.includes('文本分析'));assert.equal(audioPosts,0);assert.equal(textRequest.rubric,'oral-v1');assert.equal(await page.locator('#useAudioAssessment').isDisabled(),true);
    }else{
      await page.waitForFunction(()=>document.getElementById('finalEvaluationProgress').textContent.includes('真实录音诊断已完成'),null,{timeout:25000});assert.equal(audioPosts,2,'reconnect reuses the same submission ID');assert.equal(await page.locator('#scorePanel').isVisible(),false);assert.equal(await page.locator('#oralReportDimensions li').count(),8);assert.match(await page.locator('#oralReportSummary').innerText(),scenario==='audio-review'?/含AI估计/:/没有八项综合分/);assert.match(await page.locator('#oralReportMetrics').innerText(),/120 WPM/);assert.equal(await page.locator('#comparisonPolished').innerText(),polished);
      assert.equal(speechRequest.audioReviewConsent,['audio-review','review-failure'].includes(scenario));
      if(scenario==='audio-review'){assert.equal(await page.locator('[data-audio-review-start]').count(),2);assert.match(await page.locator('#oralReportAudioReview').innerText(),/模型独立听到/);assert.match(await page.locator('#oralReportNotice').innerText(),/未经人工校准/);if(process.env.XFYUN_SCREENSHOT_DIR)await page.locator('#oralReportPanel').screenshot({path:path.join(process.env.XFYUN_SCREENSHOT_DIR,'audio-review-report.png')});}
      if(scenario==='review-failure')assert.match(await page.locator('#oralReportNotice').innerText(),/百炼音频分析超时/);
      if(scenario==='no-transcript'){assert.equal(speechRequest.text,'');assert.equal(await page.locator('#oralReportDimensions strong').allInnerTexts().then(a=>a.filter(s=>s==='待评').length),5);}
      await page.locator('[data-audio-word-speak]').click();assert.equal(await page.evaluate(()=>window.__spoken.at(-1).lang),'en-GB');
      if(scenario==='speech'&&process.env.XFYUN_SCREENSHOT_DIR){
        await page.locator('#oralReportPanel').screenshot({path:path.join(process.env.XFYUN_SCREENSHOT_DIR,'xfyun-report-1280.png')});
        await page.setViewportSize({width:390,height:900});await page.locator('#oralReportPanel').screenshot({path:path.join(process.env.XFYUN_SCREENSHOT_DIR,'xfyun-report-390.png')});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      await page.locator('#saveSessionBtn').click();await page.locator('[data-nav="past"]').click();await page.locator('.history-item').waitFor();assert.match(await page.locator('.history-item').innerText(),/真实录音.*讯飞/);assert.equal(await page.locator('.history-item audio').count(),2);
      const pendingDownload=page.waitForEvent('download');await page.locator('#exportHistoryBtn').click();const backup=JSON.parse(fs.readFileSync(await(await pendingDownload).path(),'utf8'));
      assert.equal(backup.records[0].finalEvaluation.oralReport.mode,'speech');assert.equal(backup.records[0].finalEvaluation.overall,undefined,'a text-model score must not appear as a speech total');
      page.once('dialog',d=>d.accept());await page.locator('#clearHistoryBtn').click();await page.waitForFunction(()=>document.querySelectorAll('.history-item').length===0);
      await page.locator('#historyFileInput').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('.history-item').waitFor();assert.match(await page.locator('.history-item').innerText(),/发音准确度/);
      const saved=await page.locator('.history-item').innerText();await page.reload();await page.locator('[data-nav="past"]').click();await page.locator('.history-item').waitFor();assert.equal(await page.locator('.history-item').innerText(),saved);
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();console.log('PASS new audio workflow, actual 48-kHz stereo WAV conversion and preserved practice:',scenario);
  }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
