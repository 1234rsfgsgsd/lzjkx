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

let provider, child, base;
let providerStatus = 200;
let providerReply;
let lastRequest;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
before(async () => {
  provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = JSON.parse(Buffer.concat(chunks));
    const isVision = Array.isArray(lastRequest.messages[0].content);
    const response = providerReply || completion(JSON.stringify(isVision ? fixture : {
      overall:80, grammar:75, vocabulary:80, fluency:80, coherence:85, taskCompletion:80,
      errors:[{original:'I has', correction:'I have', explanation:'主谓一致'}],
      polished:'I have a book.', sentences:[], summary:'测试结果'
    }));
    res.writeHead(providerStatus, {'Content-Type':'application/json'});
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: {...process.env, PORT:String(port), VISION_API_KEY:'test-only', VISION_API_URL:`http://127.0.0.1:${provider.address().port}`, VISION_MODEL:'test-vision', SPEECH_MODEL:'test-text'},
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
const post = (url,body) => fetch(base+url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('health and image recognition remain independent of the speech model', async () => {
  assert.equal((await fetch(base+'/health')).status,200);
  const response = await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).elements,['书本']);
  assert.equal(lastRequest.model,'test-vision');
  assert.ok(lastRequest.max_tokens >= 1200);
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
  const response=await post('/api/analyze-speech',{text:'I has a book.'});
  assert.equal(response.status,200);
  assert.equal((await response.json()).errors[0].correction,'I have');
  assert.equal(lastRequest.model,'test-text');
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
  assert.equal(result.result.polished,'I have a book.');
  assert.equal(lastRequest.model,'test-text');
  const image=await post('/api/analyze-image',{image:'data:image/jpeg;base64,/9j/2Q=='});
  assert.equal(image.status,200);
  assert.equal(lastRequest.model,'test-vision');
});
