const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createPracticeUsage}=require('../practice-usage');
const {providerError}=require('../provider-error');
const {createVisionJobs}=require('../vision-jobs');
const {normalizeEvaluation,evaluationContext}=require('../speech-evaluation');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('balance, auth and quota failures provide terminal actionable errors',()=>{
  for(const status of [402,401,403])assert.equal(providerError(status,'','识图').retryable,false);
  assert.equal(providerError(402).code,'AI_BALANCE_INSUFFICIENT');
  assert.match(providerError(402).error,/免费场景/);
  assert.equal(providerError(500).retryable,true);
  assert.equal(providerError(400,'Sorry, your account balance is insufficient').code,'AI_BALANCE_INSUFFICIENT');
});

test('daily allowances persist, isolate browsers, refund once and reset at Beijing midnight',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-usage-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');let now=Date.parse('2026-10-24T15:59:00Z');
  const options={file,limits:{scene:1,vision:2,speech:1},now:()=>now};
  const usage=createPracticeUsage(options),a={id:'a',ip:'network'},b={id:'b',ip:'network'};
  const refund=usage.reserve(a,'scene');assert.throws(()=>usage.reserve(a,'scene'),{code:'DAILY_QUOTA'});
  assert.equal(usage.view(b).used.scene,0);usage.reserve(b,'scene');
  refund();refund();assert.equal(usage.view(a).used.scene,0);usage.reserve(a,'scene');
  const restarted=createPracticeUsage(options);assert.equal(restarted.view(a).used.scene,1);
  now=Date.parse('2026-10-24T16:00:00Z');assert.equal(usage.view(a).used.scene,0);assert.equal(usage.view(a).day,'2026-10-25');
});

test('signed browser cookie is stable and tampering yields a new allowance identity',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-cookie-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const usage=createPracticeUsage({file:path.join(dir,'usage.json')});let cookie='';
  const res={setHeader:(name,value)=>{cookie=value.split(';')[0];assert.match(value,/HttpOnly/);}};
  const req={headers:{'x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}};
  const one=usage.identity(req,res);req.headers.cookie=cookie;
  assert.equal(usage.identity(req,res).id,one.id);req.headers.cookie=cookie+'bad';assert.notEqual(usage.identity(req,res).id,one.id);
});

test('shared network has a five-browser allowance cap',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-network-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const usage=createPracticeUsage({file:path.join(dir,'usage.json'),limits:{scene:1}});
  for(let i=0;i<5;i++)usage.reserve({id:String(i),ip:'same'},'scene');
  assert.throws(()=>usage.reserve({id:'sixth',ip:'same'},'scene'),{code:'DAILY_QUOTA'});
  usage.reserve({id:'sixth',ip:'other'},'scene');
});

test('image reuse is isolated by browser, intent and accent and does not reserve twice',async()=>{
  let paid=0,returned=0;
  const jobs=createVisionJobs(async body=>({intent:body.intent}));
  const base={image:'image',accent:'英式',cacheScope:'a',intent:'点咖啡',reserveUsage:()=>{paid++;return()=>returned++;}};
  const id=jobs.start({...base,requestId:crypto.randomUUID()});await tick();
  assert.equal(jobs.start({...base,requestId:crypto.randomUUID()}),id);assert.equal(paid,1);
  assert.notEqual(jobs.start({...base,intent:'谈工作'}),id);
  assert.notEqual(jobs.start({...base,cacheScope:'b'}),id);
  assert.notEqual(jobs.start({...base,accent:'美式'}),id);
  assert.equal(paid,4);assert.equal(returned,0);
  const failed=createVisionJobs(async()=>{throw Object.assign(new Error('balance'),{details:providerError(402)});});
  const fail=failed.start(base);await tick();assert.equal(returned,1);assert.equal(failed.get(fail).retryable,false);
});

test('scoring keeps only real second-transcript evidence, never the reference or invented quotes',()=>{
  const context=evaluationContext({phase:'final',text:'I have a book.',reference:'I enjoy visiting a library.'});
  const result=normalizeEvaluation({grammar:90,topicRelevance:80,coherence:90,vocabulary:80,fluency:90,polished:'I have a book.',scoreEvidence:{grammar:[{original:'I have a book.',explanation:'完整句子'},{original:'I enjoy visiting a library.',explanation:'来自参考稿'}],coherence:[{original:'invented',explanation:'捏造'}]}},context);
  assert.equal(result.scoreEvidence.grammar.length,1);assert.equal(result.scoreEvidence.coherence.length,0);
});

test('free teaching library ships image-grounded vocabulary with UK and US IPA',()=>{
  const scenes=require('../scene-library');assert.equal(scenes.length,3);
  for(const scene of scenes){assert.match(scene.image,/^data:image\/svg\+xml;base64,/);assert.ok(scene.elements.length);assert.ok(scene.hints.words.every(w=>w.length===4&&w[1]&&w[2]));}
});
