const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseVisionResult } = require('../vision-result');

const fixture = {
  scene: '看书', category: '学习校园', elements: ['书本'],
  words: [{ en: 'book', us: '/bʊk/', uk: '/bʊk/', zh: '书本' }],
  phrases: [], sentences: []
};
const completion = (content, reason = 'stop') => ({ choices: [{ message: { content }, finish_reason: reason }] });
test('JSON objects, fences, prose and content blocks retain both accents', () => {
  for (const content of [JSON.stringify(fixture), '```json\n' + JSON.stringify(fixture) + '\n```', '识别结果：\n' + JSON.stringify(fixture), [{type:'text', text:JSON.stringify(fixture)}]]) {
    const result = parseVisionResult(completion(content));
    assert.deepEqual(result.hints.words[0], ['book', '/bʊk/', '/bʊk/', '书本']);
  }
});
test('array keywords are accepted; absent elements use only actual returned keywords', () => {
  const result = parseVisionResult(completion(JSON.stringify({ ...fixture, elements: [], words:[['book','/bʊk/','/bʊk/','书本']] })));
  assert.deepEqual(result.elements, ['书本']);
});
test('truncated JSON is explicitly rejected instead of being called image recognition failure', () => {
  assert.throws(() => parseVisionResult(completion('{"scene":"看书",', 'length')), {code:'VISION_OUTPUT_TRUNCATED'});
});
test('invalid JSON and absent words do not invent a successful recognition', () => {
  assert.throws(() => parseVisionResult(completion('not JSON')), {code:'VISION_INVALID_JSON'});
  assert.throws(() => parseVisionResult(completion(JSON.stringify({...fixture,words:[null]}))), {code:'VISION_EMPTY_WORDS'});
});
test('generated-scene quality fields are preserved for the frontend retry decision', () => {
  const result = parseVisionResult(completion(JSON.stringify({ ...fixture,
    sceneMatch: false, qualityOk: false, qualityIssues: ['手部结构异常', '场景不符合预期'], visibleElements: ['咖啡杯']
  })));
  assert.equal(result.sceneMatch, false);
  assert.equal(result.qualityOk, false);
  assert.deepEqual(result.qualityIssues, ['手部结构异常', '场景不符合预期']);
  assert.deepEqual(result.visibleElements, ['咖啡杯']);
});

let provider, child, base;
let providerStatus = 200;
let providerReply;
let lastRequest;
let speechReply;
let speechRepairReply;
let speechReviewReply;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
before(async () => {
  provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = JSON.parse(Buffer.concat(chunks));
    const isVision = Array.isArray(lastRequest.messages[0].content);
    const isSpeechRepair = !isVision && lastRequest.messages.some(message => String(message.content || '').includes('润色稿实际为'));
    const isGrammarReview = !isVision && lastRequest.messages.some(message => String(message.content || '').includes('独立语法审校员'));
    const speechUser = !isVision && lastRequest.messages.map(message => {
      try { return JSON.parse(message.content); } catch { return null; }
    }).find(value => value?.speech);
    const defaultSpeech = speechUser?.speech?.length > 1000
      ? { overall:80, grammar:80, vocabulary:80, fluency:70, coherence:90, topicRelevance:75,
          errors:[{original:'I has',correction:'I have',explanation:'主谓一致'}],
          keywords:[{en:'book',zh:'书'}],keyInformation:['说话者有一本书。'],styleSuggestions:[],
          topicSummary:'介绍一本书',polished:'I have a book. '.repeat(180),sentences:[],summary:'测试结果' }
      : {
      overall:80, grammar:80, vocabulary:80, fluency:70, coherence:90, topicRelevance:75,
      errors:[{original:'I has', correction:'I have', explanation:'主谓一致'}],
      keywords:[{en:'book',zh:'书'}], keyInformation:['说话者有一本书。'], styleSuggestions:[],
      topicSummary:'介绍一本书', polished:'I have a book.', sentences:[], summary:'测试结果'
    };
    const response = providerReply || completion(JSON.stringify(isVision ? fixture : isSpeechRepair ? { polished: speechRepairReply } : isGrammarReview && speechReviewReply ? speechReviewReply : speechReply || defaultSpeech));
    res.writeHead(providerStatus, {'Content-Type':'application/json', ...(providerStatus === 429 ? {'Retry-After':'2'} : {})});
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: {...process.env, PORT:String(port), TRUST_PROXY_HOPS:'1', VISION_API_KEY:'test-only', VISION_API_URL:`http://127.0.0.1:${provider.address().port}`, VISION_MODEL:'test-vision', SPEECH_MODEL:'test-text'},
    stdio:'ignore'
  });
  for (let n=0; n<100; n++) {
    try { if ((await fetch(base+'/health')).ok) return; } catch {}
    await sleep(30);
  }
  throw new Error('Test server did not start');
});
after(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise(resolve => child.once('exit',resolve));
    child.kill(); await closed;
  }
  if (provider) await new Promise(resolve => provider.close(resolve));
});
let browserCookie='';
const post = async (url,body) => {
  const response=await fetch(base+url, {method:'POST',headers:{'Content-Type':'application/json',...(browserCookie?{Cookie:browserCookie}:{})},body:JSON.stringify(body)});
  const cookie=response.headers.get('set-cookie');if(cookie)browserCookie=cookie.split(';')[0];
  return response;
};

test('targeted tense review corrects an overzealous first pass without introducing a first-round score',async()=>{
  speechReply={errors:[{original:'like',correction:'liked',category:'时态',explanation:'统一过去时'}],polished:'Yesterday I went to a cafe. I liked it because it was quiet.',summary:'统一时态'};
  speechReviewReply={errors:[{original:'go',correction:'went',category:'时态',explanation:'Yesterday 限定过去的动作'}],polished:'Yesterday I went to a cafe. I like it because it is quiet.',summary:'保留当前喜好和事实，只改过去动作。'};
  try{
    const response=await post('/api/analyze-speech',{phase:'polish',text:'Yesterday I go to a cafe. I like it because it is quiet.'});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.errors.length,1);assert.equal(result.errors[0].original,'go');assert.match(result.polished,/I like it because it is quiet/);assert.equal(result.overall,undefined);assert.equal(result.reviewWarning,undefined);
    assert.ok(lastRequest.messages.some(message=>message.content.includes('独立语法审校员')));
  }finally{speechReply=undefined;speechReviewReply=undefined;}
});

test('an unsuccessful targeted review preserves the result with an explicit uncertainty warning',async()=>{
  speechReply={errors:[{original:'like',correction:'liked',category:'时态',explanation:'统一过去时'}],polished:'Yesterday I went to a cafe. I liked it.',summary:'时态'};
  speechReviewReply={polished:''};
  try{
    const response=await post('/api/analyze-speech',{phase:'polish',text:'Yesterday I went to a cafe. I like it.'});assert.equal(response.status,200);
    const result=await response.json();assert.match(result.reviewWarning,/仅供参考/);assert.ok(result.polished);assert.equal(result.overall,undefined);
  }finally{speechReply=undefined;speechReviewReply=undefined;}
});
test('health and image recognition remain independent of the speech model', async () => {
  assert.equal((await fetch(base+'/health')).status,200);
  const response = await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).elements,['书本']);
  assert.equal(lastRequest.model,'test-vision');
  assert.ok(lastRequest.max_tokens >= 1200);
});

test('async recognition returns an immediate task and polls normalized keywords', async () => {
  const body = { image:'data:image/jpeg;base64,/9j/2Q==', async:true, requestId:require('node:crypto').randomUUID() };
  const response = await post('/api/analyze-image', body);
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  assert.equal(jobId, body.requestId);
  assert.equal((await post('/api/analyze-image', body)).status, 202);
  let result;
  for (let i = 0; i < 50; i++) {
    const poll = await fetch(base + '/api/analyze-image/jobs/' + jobId);
    assert.equal(poll.headers.get('cache-control'), 'no-store');
    result = await poll.json();
    if (result.status !== 'pending') break;
    await sleep(10);
  }
  assert.equal(result.status, 'complete');
  assert.equal(result.result.hints.words[0][0], 'book');
  const conflict = await post('/api/analyze-image', { ...body, accent:'美式' });
  assert.equal(conflict.status, 409);
});

test('two-round jobs separate polishing from final scoring and preserve the reference', async () => {
  const initial=await post('/api/analyze-speech',{phase:'polish',text:'I has a book.'});
  assert.equal(initial.status,200);
  const polished=await initial.json();
  assert.equal(polished.phase,'polish');
  assert.equal('overall' in polished,false);
  assert.equal(polished.polished,'I have a book.');
  assert.match(lastRequest.messages[0].content,/不进行任何评分/);
  const final=await post('/api/analyze-speech',{phase:'final',text:'I has a book.',reference:polished.polished});
  assert.equal(final.status,200);
  const scored=await final.json();
  assert.equal(scored.phase,'final');
  assert.equal(typeof scored.overall,'number');
  assert.equal(scored.errors[0].original,'I has');
  const user=JSON.parse(lastRequest.messages[1].content);
  assert.equal(user.speech,'I has a book.');
  assert.equal(user.reference,'I have a book.');
});

test('reconnecting to the same speech submission preserves the job and rejects changed content', async () => {
  const body={requestId:require('node:crypto').randomUUID(),text:'I has a book.',accent:'英式'};
  const first=await post('/api/analyze-speech/jobs',body);
  const second=await post('/api/analyze-speech/jobs',body);
  assert.equal(first.status,202);
  assert.deepEqual(await first.json(),await second.json());
  const conflict=await post('/api/analyze-speech/jobs',{...body,text:'A different speech.'});
  assert.equal(conflict.status,409);
});
test('provider permission errors are not automatically retried; keys are redacted', async () => {
  providerStatus=401; providerReply={error:{message:'invalid test-only'}};
  try {
    const response=await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
    const body=await response.json();
    assert.equal(body.retryable,false);
    assert.match(body.error,/401/);
    assert.ok(!body.error.includes('test-only'));
  } finally {providerStatus=200; providerReply=undefined;}
});
test('provider rate limits return a wait hint instead of encouraging rapid retries', async () => {
  providerStatus=429; providerReply={error:{message:'rate limit reached'}};
  try {
    const response=await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
    const body=await response.json();
    assert.equal(response.status,429);
    assert.equal(body.retryable,false);
    assert.equal(body.retryAfterMs,2000);
    assert.match(body.error,/等待约 2 秒后再试/);
  } finally {providerStatus=200; providerReply=undefined;}
});
test('image rate limits are isolated by forwarded client IP and do not block speech evaluations', async () => {
  const headers={'Content-Type':'application/json','X-Forwarded-For':'203.0.113.10'};
  for(let n=0;n<24;n++) {
    const response=await fetch(base+'/api/analyze-image',{method:'POST',headers,body:JSON.stringify({image:'data:image/jpeg;base64,/9j/2Q=='})});
    assert.equal(response.status,200);
  }
  const limited=await fetch(base+'/api/analyze-image',{method:'POST',headers,body:JSON.stringify({image:'data:image/jpeg;base64,/9j/2Q=='})});
  const limitedBody=await limited.json();
  assert.equal(limited.status,429);
  assert.equal(limitedBody.code,'LOCAL_RATE_LIMIT');
  assert.equal(limitedBody.retryable,false);
  const speech=await fetch(base+'/api/analyze-speech',{method:'POST',headers,body:JSON.stringify({text:'I have a book.'})});
  assert.equal(speech.status,200);
  const otherClient=await fetch(base+'/api/analyze-image',{method:'POST',headers:{...headers,'X-Forwarded-For':'203.0.113.11'},body:JSON.stringify({image:'data:image/jpeg;base64,/9j/2Q=='})});
  assert.equal(otherClient.status,200);
});
test('truncated model output gets an explicit retriable error', async () => {
  providerReply=completion('{"scene":', 'length');
  try {
    const response=await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
    const body=await response.json();
    assert.equal(body.code,'VISION_OUTPUT_TRUNCATED');
    assert.equal(body.retryable,true);
  } finally {providerReply=undefined;}
});
test('the existing speech endpoint still returns actual model corrections', async () => {
  const response=await post('/api/analyze-speech',{text:'I has a book.',accent:'英式',topic:{scene:'阅读',likelyIntent:'介绍书本',elements:['书']}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.errors[0].correction,'I have');
  assert.equal(body.overall,80);
  assert.equal(body.topicRelevance,75);
  assert.equal(body.accent,'英式');
  assert.deepEqual(body.scoreWeights,{grammar:.35,topicRelevance:.25,coherence:.2,vocabulary:.1,fluency:.1});
  assert.equal(body.originalWordCount,4);
  assert.equal(body.targetMinWords,1);
  assert.equal(body.targetMaxWords,104);
  assert.equal(body.wordCountWithinRange,true);
  assert.equal(body.keywords[0].en,'book');
  assert.equal(lastRequest.model,'test-text');
  assert.match(lastRequest.messages[0].content,/British English/);
  assert.match(lastRequest.messages[0].content,/grammar 语法准确度35%/);
  const userData=JSON.parse(lastRequest.messages[1].content);
  assert.equal(userData.topic.likelyIntent,'介绍书本');
  assert.equal(userData.speech,'I has a book.');
});
test('speech evaluation preserves all valid model corrections and keeps optional style advice separate', async () => {
  const text=Array.from({length:12},(_,i)=>`Mistake${i} happened.`).join(' ');
  speechReply={
    grammar:60,topicRelevance:90,coherence:80,vocabulary:70,fluency:50,
    errors:Array.from({length:12},(_,i)=>({original:`Mistake${i}`,correction:`Correction${i}`,explanation:'具体问题'})),
    styleSuggestions:[{original:'Mistake0',suggestion:'An event',explanation:'可选表达提升'}],
    keywords:[{en:'experience',zh:'经历'}],keyInformation:['口述介绍一次经历。'],topicSummary:'一次经历',
    polished:'I described one meaningful experience with useful details.',summary:'测试'
  };
  try {
    const response=await post('/api/analyze-speech',{text,accent:'美式'});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.errors.length,12);
    assert.equal(body.overall,72);
    assert.equal(body.styleSuggestions.length,1);
    assert.equal(body.polishedWordCount,8);
    assert.equal(body.wordCountWithinRange,true);
  } finally {speechReply=undefined;}
});
test('an out-of-range polished answer gets a length-only repair before it is returned', async () => {
  const text='Dumplings are important in northern China. '.repeat(40);
  speechReply={
    grammar:80,topicRelevance:85,coherence:80,vocabulary:75,fluency:80,
    errors:[],keywords:[{en:'dumplings',zh:'饺子'}],keyInformation:['饺子在北方饮食中很重要。'],
    polished:'Dumplings matter to me.',summary:'测试字数校正'
  };
  speechRepairReply='My family enjoys dumplings during special occasions, and they remind me of home. '.repeat(25);
  try {
    const response=await post('/api/analyze-speech',{text,accent:'英式',topic:{scene:'饺子'}});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.wordCountWithinRange,true);
    assert.ok(body.polishedWordCount>=body.targetMinWords);
    assert.ok(body.polishedWordCount<=body.targetMaxWords);
    assert.equal(body.polished,speechRepairReply.trim());
    assert.equal(lastRequest.messages.some(message => String(message.content || '').includes('润色稿实际为')),true);
  } finally {speechReply=undefined;speechRepairReply=undefined;}
});
test('long text jobs can be submitted and polled without affecting image recognition', async () => {
  const response=await post('/api/analyze-speech/jobs',{text:'I has a book. '.repeat(180)});
  assert.equal(response.status,202);
  const {jobId}=await response.json();
  let result;
  for(let n=0;n<100;n++) {
    result=await (await fetch(base+'/api/analyze-speech/jobs/'+jobId)).json();
    if(result.status!=='pending') break;
    await sleep(20);
  }
  assert.equal(result.status,'complete');
  assert.ok(result.result.wordCountWithinRange);
  assert.ok(result.result.polishedWordCount>=result.result.targetMinWords);
  assert.ok(result.result.polishedWordCount<=result.result.targetMaxWords);
  assert.equal(lastRequest.model,'test-text');
  const image=await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
  assert.equal(image.status,200);
  assert.equal(lastRequest.model,'test-vision');
});
