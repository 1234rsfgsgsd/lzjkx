const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { sceneConfig, scenePrompt } = require('../scene-generation');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/z9sAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let base, provider, child, providerCalls = 0, lastRequest, providerStatus = 200, invalidImage = false, providerGate;

test('SiliconFlow scene configuration is separate from recognition and speech; foreign hosts do not receive the vision key', () => {
  for (const host of ['api.siliconflow.cn', 'api.siliconflow.com']) {
    const config = sceneConfig({ VISION_API_URL: `https://${host}/v1/chat/completions`, VISION_API_KEY: 'private-key', VISION_MODEL: 'vision-only', SPEECH_MODEL: 'text-only' });
    assert.equal(config.apiUrl, `https://${host}/v1/images/generations`);
    assert.equal(config.model, 'Tongyi-MAI/Z-Image-Turbo');
    assert.equal(config.apiKey, 'private-key');
  }
  const custom = sceneConfig({ VISION_API_URL: 'https://api.siliconflow.cn/v1/chat/completions', VISION_API_KEY: 'private-key', SCENE_IMAGE_API_URL: 'https://other.example/images' });
  assert.equal(custom.apiKey, '');
});

test('photography prompts keep the actual activity and category-specific details', () => {
  const cafe = scenePrompt({ name: '咖啡厅', category: '餐饮美食', elements: ['咖啡', '菜单'] });
  const supermarket = scenePrompt({ name: '超市购物', category: '购物消费', elements: ['购物车', '货架'] });
  assert.match(cafe, /documentary photograph/);
  assert.match(cafe, /natural daylight/);
  assert.match(cafe, /ordering a latte/);
  assert.match(supermarket, /supermarket/);
  assert.match(supermarket, /customer choosing products/);
  assert.notEqual(cafe, supermarket);
});

before(async () => {
  provider = http.createServer(async (req, res) => {
    if (req.url === '/picture.png') {
      res.writeHead(200, { 'Content-Type': invalidImage ? 'text/html' : 'image/png' });
      return res.end(invalidImage ? '<html>unavailable</html>' : png);
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = JSON.parse(Buffer.concat(chunks));
    providerCalls++;
    if (providerGate) await providerGate;
    res.writeHead(providerStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(providerStatus === 200
      ? { images: [{ url: `http://127.0.0.1:${provider.address().port}/picture.png` }] }
      : { error: { message: 'invalid scene-secret' } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(port), SCENE_IMAGE_API_URL: `http://127.0.0.1:${provider.address().port}/generations`, SCENE_IMAGE_API_KEY: 'scene-secret', SCENE_IMAGE_MODEL: 'photo-model' },
    stdio: 'ignore'
  });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await sleep(30);
  }
  throw new Error('Test server did not start');
});

after(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await stopped;
  }
  if (provider) await new Promise(resolve => provider.close(resolve));
});

const sceneBody = () => ({ requestId: crypto.randomUUID(), category: '餐饮美食', name: '咖啡厅', elements: ['咖啡', '菜单'] });
const post = body => fetch(base + '/api/generate-scene/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function finished(id) {
  for (let n = 0; n < 100; n++) {
    const result = await (await fetch(base + '/api/generate-scene/jobs/' + id)).json();
    if (result.status !== 'pending') return result;
    await sleep(20);
  }
  throw new Error('Scene job did not finish');
}

test('scene jobs return immediately; reconnecting to the same job does not generate or charge twice', async () => {
  let release;
  providerGate = new Promise(resolve => { release = resolve; });
  const body = sceneBody();
  const callsBefore = providerCalls;
  try {
    const response = await post(body);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobId, body.requestId);
    const pending = await (await fetch(base + '/api/generate-scene/jobs/' + body.requestId)).json();
    assert.equal(pending.status, 'pending');
    assert.equal((await post(body)).status, 202);
    assert.equal((await fetch(base + '/health')).status, 200, 'long generation must not block health checks');
    const conflict = await post({ ...body, name: '超市' });
    assert.equal(conflict.status, 409);
    release();
    const result = await finished(body.requestId);
    assert.equal(result.status, 'complete');
    assert.equal(providerCalls - callsBefore, 1);
    assert.equal(lastRequest.model, 'photo-model');
    assert.equal(lastRequest.image_size, '1024x576');
    assert.match(lastRequest.prompt, /ordering a latte/);
    assert.match(lastRequest.negative_prompt, /typography/);
    assert.equal(result.result.image, 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(result.result.name, '咖啡厅');
    assert.ok(!JSON.stringify(result).includes('scene-secret'));
  } finally { release(); providerGate = undefined; }
});

test('provider permission failures are explicit and do not cause additional image calls', async () => {
  providerStatus = 401;
  const count = providerCalls;
  try {
    const body = sceneBody();
    assert.equal((await post(body)).status, 202);
    const result = await finished(body.requestId);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /401/);
    assert.match(result.error, /账户余额/);
    assert.ok(!result.error.includes('scene-secret'));
    assert.equal(providerCalls - count, 1);
  } finally { providerStatus = 200; }
});

test('expired jobs and invalid image responses report errors instead of showing a placeholder as a photo', async () => {
  assert.equal((await fetch(base + '/api/generate-scene/jobs/' + crypto.randomUUID())).status, 404);
  invalidImage = true;
  try {
    const body = sceneBody();
    await post(body);
    const result = await finished(body.requestId);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /图片内容无效/);
    assert.equal(result.result, undefined);
  } finally { invalidImage = false; }
});

test('invalid scenes fail before invoking the paid provider', async () => {
  const count = providerCalls;
  assert.equal((await post({ ...sceneBody(), category: 'not-a-category' })).status, 400);
  assert.equal(providerCalls, count);
});
