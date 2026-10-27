const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {configuration,validateAudio,signedUrl,parseResult,createXfyunAssessor}=require('../xfyun-ise');
const {dimensions,TEXT_WEIGHTS,textReport,speechReport,readingPace}=require('../oral-rubric');
const {createXfyunBudget}=require('../xfyun-budget');
const {createPronunciationJobs}=require('../pronunciation-jobs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const env={XFYUN_ISE_ENABLED:'true',XFYUN_APP_ID:'app',XFYUN_API_KEY:'key',XFYUN_API_SECRET:'secret'};
const makeAudio=(seconds=5,value=1000)=>{const pcm=Buffer.alloc(seconds*16000*2);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(value,i);return 'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64');};
const xml=`<?xml version="1.0" encoding="utf-8"?><xml_result><read_chapter accuracy_score="82" fluency_score="78" integrity_score="100" total_score="81" except_info="0" is_rejected="false"><sentence accuracy_score="82" fluency_score="78"><word beg_pos="0" end_pos="36" content="Hello" total_score="92" dp_message="0"><syll beg_pos="0" end_pos="36" content="hello" dp_message="0"><phone beg_pos="0" end_pos="18" content="hh" dp_message="0"/></syll></word><word beg_pos="50" end_pos="82" content="world" total_score="45" dp_message="128"><syll beg_pos="50" end_pos="82" content="world" dp_message="128"><phone beg_pos="50" end_pos="82" content="er" dp_message="128"/></syll></word></sentence></read_chapter></xml_result>`;
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfyun-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'calls.json');}
test('credentials are opt-in and no actual secret is returned to the client configuration',()=>{
  assert.equal(configuration({}).enabled,false);const c=configuration(env);assert.equal(c.enabled,true);assert.equal(c.maxSeconds,180);assert.deepEqual(c.unavailable,['independent-prosody-score','independent-intelligibility-score']);assert.equal(JSON.stringify(c).includes('secret'),false);
});
test('audio validation requires non-silent mono 16-kHz PCM, a reference and bounded English passage',()=>{
  assert.equal(validateAudio({audio:makeAudio(),reference:'“Hello — world!”'}).reference,"'Hello - world!'");
  for(const bad of [{audio:'',reference:'Hello.'},{audio:makeAudio(2),reference:'Hello.'},{audio:makeAudio(5,0),reference:'Hello.'},{audio:makeAudio(),reference:''}])assert.throws(()=>validateAudio(bad));
  assert.throws(()=>validateAudio({audio:makeAudio(),reference:'One sentence '.repeat(101)+'.'}),{code:'AUDIO_REFERENCE_TOO_LONG'});
  assert.throws(()=>validateAudio({audio:'data:audio/ogg;base64,AAAA',reference:'Hello.'}),{code:'AUDIO_FORMAT_INVALID'});
});
test('WebSocket authorization signs the RFC1123 date and host without exposing secret in URL',()=>{
  const date=new Date('2026-10-26T01:02:03.000Z'),url=new URL(signedUrl({apiKey:'visible-key',apiSecret:'private',now:date}));
  assert.equal(url.protocol,'wss:');assert.equal(url.host,'ise-api.xfyun.cn');assert.equal(url.searchParams.get('date'),date.toUTCString());assert.equal(url.searchParams.get('host'),url.host);assert.ok(url.searchParams.get('authorization'));assert.equal(url.href.includes('private'),false);
  const expected=crypto.createHmac('sha256','private').update('host: ise-api.xfyun.cn\ndate: '+date.toUTCString()+'\nGET /v2/open-ise HTTP/1.1').digest('base64');assert.ok(Buffer.from(url.searchParams.get('authorization'),'base64').toString().includes(expected));
});
test('full-dimension XML result preserves real scores, word alignment, substitutions and long pauses',()=>{
  const result=parseResult(xml,{durationSeconds:5});assert.equal(result.status,'scored');assert.deepEqual(result.scores,{accuracy:82,fluency:78,integrity:100,total:81});assert.deepEqual(result.words.map(w=>[w.text,w.error,w.start,w.end]),[['Hello','',0,.36],['world','替换',.5,.82]]);assert.equal(result.words[1].phones[0].symbol,'er');assert.equal(result.metrics.wpm,null);
  const long=xml.replace('end_pos="82"','end_pos="460"').replace('beg_pos="50"','beg_pos="260"').replace('</sentence>','<word beg_pos="480" end_pos="500" content="again" total_score="80" dp_message="0"/></sentence>');const metrics=parseResult(long,{durationSeconds:8}).metrics;assert.equal(metrics.wpm,36);assert.equal(metrics.longPauseCount,1);
});
test('unscorable and invalid XML never produce fabricated scores',()=>{
  assert.equal(parseResult(xml.replace('is_rejected="false"','is_rejected="true"'),{durationSeconds:5}).status,'unscorable');
  assert.equal(parseResult(xml.replace('integrity_score="100"','integrity_score="20"'),{durationSeconds:5}).status,'incomplete');
  assert.throws(()=>parseResult('<!DOCTYPE x [<!ENTITY a "b">]>', {durationSeconds:5}),{code:'XFYUN_RESULT_INVALID'});
});
test('WebSocket client requests complete assessment fields and sends ordered bounded frames',async()=>{
  class FakeSocket extends EventEmitter{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(url,options){super();FakeSocket.instance=this;this.url=url;this.options=options;this.readyState=0;this.frames=[];queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
    send(raw){const msg=JSON.parse(raw);this.frames.push(msg);if(msg.business?.aus===4){const response={code:0,data:{status:2,data:Buffer.from(xml).toString('base64')}};queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify(response))));}}
    close(){this.readyState=3;this.emit('close');}terminate(){this.close();}
  }
  const assessor=createXfyunAssessor({env,WebSocketClass:FakeSocket,frameIntervalMs:0});const input=validateAudio({audio:makeAudio(3),reference:'Hello world.'});
  const result=await assessor.assess(input);assert.equal(result.scores.accuracy,82);const frames=FakeSocket.instance.frames;
  assert.equal(frames[0].business.rst,'entirety');assert.equal(frames[0].business.ise_unite,'1');assert.equal(frames[0].business.extra_ability,'multi_dimension;syll_phone_err_msg');assert.equal(frames[0].common.app_id,'app');assert.match(frames[0].business.text,/^\uFEFF\[content\]\nHello world\./);
  assert.equal(frames[1].business.aus,1);assert.equal(frames.at(-1).business.aus,4);assert.equal(frames.at(-1).data.status,2);
  assert.deepEqual(Buffer.concat(frames.slice(1,-1).map(frame=>Buffer.from(frame.data.data,'base64'))),input.pcm);
  assert.ok(frames.slice(1,-1).every(frame=>Buffer.from(frame.data.data,'base64').length<=1280));
});
test('rubric distinguishes text scores from incomplete acoustic measures without inventing a total',()=>{
  assert.deepEqual(TEXT_WEIGHTS,{grammar:.35,vocabulary:.3,topicRelevance:.35});assert.equal(readingPace(100),9.5);assert.equal(readingPace(75),5.5);assert.equal(dimensions.reduce((s,d)=>s+d.max,0),100);
  const text=textReport({grammar:80,vocabulary:70,topicRelevance:90});assert.equal(text.overallScore,81);assert.equal(text.mode,'text');assert.equal(text.dimensionScores.length,3);
  const acoustic={status:'scored',scores:{accuracy:80,fluency:70},metrics:{wpm:100},words:[]};const voice=speechReport(acoustic,{grammar:80,vocabulary:70,topicRelevance:90});
  assert.equal(voice.overallScore,null);assert.equal(voice.coverage,'partial');assert.equal(voice.dimensionScores.find(d=>d.key==='pronunciation').score,16);assert.equal(voice.dimensionScores.find(d=>d.key==='pace').score,9.5);assert.equal(voice.dimensionScores.find(d=>d.key==='prosody').score,null);assert.equal(voice.dimensionScores.find(d=>d.key==='intelligibility').score,null);
});
test('provider call budget records usage without imposing a site hard limit',t=>{
  let clock=Date.parse('2026-10-26T02:00:00Z');const file=fixture(t),budget=createXfyunBudget({file,now:()=>clock});for(let i=0;i<4;i++)budget.reserve();assert.equal(budget.view().monthUsed,4);assert.equal('dailyLimit' in budget.view(),false);assert.equal('monthlyLimit' in budget.view(),false);
});
test('pronunciation job is idempotent per user, marks provider calls before launch and never exposes raw audio',async t=>{
  const file=fixture(t),user={id:'browser'},usage={used:0},budget=createXfyunBudget({file});let audioCalls=0,textCalls=0;
  const assessor={configuration:()=>({enabled:true}),assess:async input=>{audioCalls++;assert.equal(input.reference,'Hello world.');return {status:'scored',scores:{accuracy:80,fluency:75},metrics:{wpm:100,alignedWordCount:2},words:[]};}};
  const textEval=async()=>{textCalls++;return {grammar:80,vocabulary:75,topicRelevance:90,scoreReasons:{}};};
  const jobs=createPronunciationJobs({assessor,budget,evaluateText:textEval,reserveUsage:()=>{usage.used++;return()=>usage.used--;}});
  const body={requestId:'a7b4f889-62eb-49a7-89e4-9c43fe4d9ac2',audio:makeAudio(),text:'Hello world.',reference:'Hello world.',phase:'final',rubric:'oral-v1',accent:'英式'};
  assert.equal(jobs.start(body,user),body.requestId);assert.equal(jobs.start(body,user),body.requestId);await new Promise(r=>setTimeout(r,10));const result=jobs.get(body.requestId,user);
  assert.equal(result.status,'complete');assert.equal(result.result.report.mode,'speech');assert.equal(result.result.report.overallScore,null);assert.equal(audioCalls,1);assert.equal(textCalls,1);assert.equal(usage.used,1);assert.equal(budget.view().monthUsed,1);assert.equal(JSON.stringify(result).includes(body.audio),false);
  assert.throws(()=>jobs.get(body.requestId,{id:'other'}),{code:'AUDIO_JOB_NOT_FOUND'});
  assert.throws(()=>jobs.start(body,{id:'other'}),{code:'AUDIO_REQUEST_CONFLICT'});
});
