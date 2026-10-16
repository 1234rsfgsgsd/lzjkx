const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { categories, parseVisionResult } = require('./vision-result');
const { evaluationContext, evaluationPrompt, parseCompletion, normalizeEvaluation } = require('./speech-evaluation');
const { createSceneGenerator } = require('./scene-generation');
const sceneGenerator = createSceneGenerator();

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.VISION_API_KEY;
const apiUrl = process.env.VISION_API_URL;
const model = process.env.VISION_MODEL;
const speechModel = process.env.SPEECH_MODEL || model;
const maxBytes = 10 * 1024 * 1024;
const maxBodyBytes = 15 * 1024 * 1024;
const trustedProxyHops = Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 1));
const windows = new Map();
const speechJobs = new Map();
const crypto = require('node:crypto');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('照片过大，请选择小于 10 MB 的图片'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('请求数据格式无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function allowedRequest(req, res) {
  const now = Date.now();
  const forwarded = req.headers['x-forwarded-for']?.split(',').map(value => value.trim()).filter(Boolean) || [];
  // The rightmost X-Forwarded-For entries are supplied by trusted proxies.
  // With one trusted Render hop and one forwarded entry, index 0 is the client.
  const clientIndex = forwarded.length - trustedProxyHops;
  const ip = trustedProxyHops > 0 && forwarded.length ? forwarded[clientIndex] : req.socket.remoteAddress;
  for (const [key, value] of windows) if (now - value.start > 120_000) windows.delete(key);
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const route = pathname.startsWith('/api/analyze-speech') ? 'speech' : pathname;
  const limit = route === '/api/analyze-image' ? 24 : 12;
  const bucket = `${ip}:${route}`;
  const entry = windows.get(bucket);
  if (!entry || now - entry.start > 60_000) windows.set(bucket, { start: now, count: 1 });
  else if (++entry.count > limit) {
    const retryAfterMs = Math.max(0, 60_000 - (now - entry.start));
    send(res, 429, {
      error: `该功能的请求过于频繁，请等待约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试。`,
      code: 'LOCAL_RATE_LIMIT', retryable: false, retryAfterMs
    });
    return false;
  }
  return true;
}

function retryAfterMilliseconds(value, fallback = 30_000) {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(300_000, seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(300_000, timestamp - Date.now())) : fallback;
}

async function analyze(req, res) {
  if (!apiKey || !apiUrl || !model) {
    send(res, 503, { error: '服务器还没有配置视觉模型服务', code: 'VISION_NOT_CONFIGURED', retryable: false });
    return;
  }
  const body = await readBody(req);
  if (typeof body.image !== 'string' || body.image.length > maxBytes * 1.4) {
    send(res, 400, { error: '图片数据无效或超过 10 MB' });
    return;
  }
  const match = body.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || Buffer.from(match[2], 'base64').length > maxBytes) {
    send(res, 400, { error: '仅支持小于 10 MB 的 JPG、PNG 或 WebP 图片' });
    return;
  }

  const prompt = `你是英语口语陪练的看图教练。快速观察图片，只返回严格 JSON，不要 markdown。scene 是简洁中文场景；category 从${categories.join('、')}中选一个；likelyIntent 是学习者最可能表达的意图；elements 返回4-6个确实可见的中文要点，禁止臆造。words 返回5-6个贴合画面的英文词，每项有 en、us（美式 IPA）、uk（英式 IPA）、zh；phrases 最多2个，每项有 en、zh；sentences 最多1句，每项有 en、zh。难度按${String(body.education || '大学及以上').slice(0, 30)}控制。格式：{"scene":"...","category":"...","likelyIntent":"...","elements":["..."],"words":[{"en":"...","us":"/.../","uk":"/.../","zh":"..."}],"phrases":[{"en":"...","zh":"..."}],"sentences":[{"en":"...","zh":"..."}]}`;
  const upstream = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: body.image } }
      ] }],
      temperature: 0.25,
      max_tokens: 1400,
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const responseText = await upstream.text();
  let result = {};
  try { result = JSON.parse(responseText); } catch {}
  if (!upstream.ok) {
    const providerMessage = String(result.error?.message || result.message || responseText || 'no response details')
      .replaceAll(apiKey, '[redacted]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 500);
    console.error('Vision provider returned', upstream.status, providerMessage);
    const guidance = upstream.status === 401 || upstream.status === 403
      ? `视觉服务拒绝了请求（${upstream.status}）。请在 SiliconFlow 检查 API Key、账户余额和该模型的调用权限。${providerMessage}`
      : upstream.status === 429
        ? `视觉服务当前请求较多，请等待约 ${Math.ceil(retryAfterMilliseconds(upstream.headers.get('retry-after')) / 1000)} 秒后再试。${providerMessage}`
      : `视觉服务请求失败（${upstream.status}）：${providerMessage}`;
    const isRateLimited = upstream.status === 429;
    send(res, isRateLimited ? 429 : 502, {
      error: guidance, code: 'VISION_PROVIDER_ERROR',
      retryable: !isRateLimited && upstream.status >= 500,
      ...(isRateLimited ? { retryAfterMs: retryAfterMilliseconds(upstream.headers.get('retry-after')) } : {})
    });
    return;
  }
  try {
    send(res, 200, parseVisionResult(result));
  } catch (error) {
    console.error('Vision result rejected', error.code || 'VISION_INVALID_RESULT', 'finish_reason:', result.choices?.[0]?.finish_reason || 'unknown');
    send(res, 502, { error: error.message, code: error.code || 'VISION_INVALID_RESULT', retryable: true });
  }
}

async function evaluateSpeech(body) {
  if (!apiKey || !apiUrl || !model) {
    throw Object.assign(new Error('服务器还没有配置语言模型服务'), { status: 503 });
  }
  const context = evaluationContext(body);
  const deadline = Date.now() + 180_000;
  const messages = [
    { role: 'system', content: evaluationPrompt(context) },
    { role: 'user', content: JSON.stringify({ topic: context.topic, speech: context.text }) }
  ];
  async function complete(messages, maxTokens) {
    const upstream = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: speechModel,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens
    }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(120_000, deadline - Date.now())))
  });
  const responseText = await upstream.text();
  let result = {};
  try { result = JSON.parse(responseText); } catch {}
  if (!upstream.ok) {
    const providerMessage = String(result.error?.message || result.message || responseText || 'no response details')
      .replaceAll(apiKey, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
    console.error('Speech provider returned', upstream.status, providerMessage);
    throw Object.assign(new Error(`语言模型请求失败（${upstream.status}）：${providerMessage}`), { status: 502 });
  }
    try { return parseCompletion(result); }
    catch (error) { throw Object.assign(error, { status: 502 }); }
  }
  try {
    const parsed = await complete(messages, Math.min(8000, Math.max(3500, context.originalWordCount * 8)));
    let evaluation = normalizeEvaluation(parsed, context);
    if (!evaluation.wordCountWithinRange) {
      // Repair only the paragraph so a length correction does not redo scoring or lose errors.
      const repaired = await complete([
        ...messages,
        { role: 'assistant', content: JSON.stringify({ polished: evaluation.polished }) },
        { role: 'user', content: `润色稿实际为${evaluation.polishedWordCount}词，超出要求。请参照原口述保留所有主要信息，重新生成一整段${context.targetMinWords}–${context.targetMaxWords}词的${context.accent}英语文本。只返回JSON：{"polished":"完整段落"}。不添加虚构信息。` }
      ], Math.min(4000, Math.max(1200, context.targetMaxWords * 3)));
      evaluation = normalizeEvaluation({ ...parsed, polished: repaired.polished }, context);
      if (!evaluation.wordCountWithinRange) {
        evaluation.lengthWarning = '润色稿经调整仍超出目标词数，已保留全文，请重新评测。';
      }
    }
    return evaluation;
  } catch (error) {
    if (!error.status && error.name !== 'TimeoutError' && error.name !== 'AbortError') error.status = 502;
    throw error;
  }
}

async function analyzeSpeech(req, res) {
  const body = await readBody(req);
  const result = await evaluateSpeech(body);
  send(res, 200, result);
}

function cleanSpeechJobs() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, job] of speechJobs) if (job.createdAt < cutoff) speechJobs.delete(id);
}

async function startSpeechJob(req, res) {
  const body = await readBody(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return send(res, 400, { error: '口述内容为空' });
  if (text.length > 6000) return send(res, 413, { error: '口述内容过长，请控制在 6000 个字符以内' });
  cleanSpeechJobs();
  if (speechJobs.size >= 50) return send(res, 503, { error: '评测任务较多，请稍后再试' });
  const jobId = crypto.randomUUID();
  speechJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  evaluateSpeech(body).then(result => {
    speechJobs.set(jobId, { status: 'complete', result, createdAt: Date.now() });
  }).catch(error => {
    console.error('Speech job failed', error.name || 'Error', String(error.message || error).slice(0, 300));
    speechJobs.set(jobId, {
      status: 'failed',
      error: error.status ? error.message : (error.name === 'TimeoutError' || error.name === 'AbortError' ? '语言模型响应超时，请稍后重试' : '语言评测服务暂时不可用，请稍后重试'),
      createdAt: Date.now()
    });
  });
  send(res, 202, { jobId });
}

function getSpeechJob(res, jobId) {
  cleanSpeechJobs();
  const job = speechJobs.get(jobId);
  if (!job) return send(res, 404, { error: '评测任务已过期，请重新提交' });
  if (job.status === 'pending') return send(res, 200, { status: 'pending' });
  if (job.status === 'failed') return send(res, 200, { status: 'failed', error: job.error });
  return send(res, 200, { status: 'complete', result: job.result });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/generate-scene/jobs') {
    if (!allowedRequest(req, res)) return;
    try {
      const body = await readBody(req);
      return send(res, 202, { jobId: sceneGenerator.start(body) });
    } catch (error) {
      return send(res, error.status || 502, { error: error.status ? error.message : '无法启动场景图片生成，请稍后重试', code: error.code || 'SCENE_GENERATION_ERROR', retryable: false });
    }
  }
  const sceneJobMatch = url.pathname.match(/^\/api\/generate-scene\/jobs\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && sceneJobMatch) {
    try { return send(res, 200, sceneGenerator.get(sceneJobMatch[1])); }
    catch (error) { return send(res, error.status || 502, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/analyze-image') {
    if (!allowedRequest(req, res)) return;
    try { await analyze(req, res); }
    catch (error) {
      console.error('Analyze request failed', error.name || 'Error', String(error.message || error).slice(0, 300));
      if (!res.headersSent) send(res, error.status || 502, { error: error.status ? error.message : (error.name === 'TimeoutError' || error.name === 'AbortError' ? '视觉模型响应超时，请稍后重试' : '识图服务暂时不可用，请稍后重试') });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/analyze-speech') {
    if (!allowedRequest(req, res)) return;
    try { await analyzeSpeech(req, res); }
    catch (error) {
      console.error('Speech analysis failed', error.name || 'Error', String(error.message || error).slice(0, 300));
      if (!res.headersSent) send(res, error.status || 502, { error: error.status ? error.message : (error.name === 'TimeoutError' || error.name === 'AbortError' ? '语言模型响应超时，请稍后重试' : '语言评测服务暂时不可用，请稍后重试') });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/analyze-speech/jobs') {
    if (!allowedRequest(req, res)) return;
    try { await startSpeechJob(req, res); }
    catch (error) {
      console.error('Speech job start failed', error.name || 'Error', String(error.message || error).slice(0, 300));
      if (!res.headersSent) send(res, error.status || 502, { error: error.status ? error.message : '无法启动评测，请稍后重试' });
    }
    return;
  }
  const speechJobMatch = url.pathname.match(/^\/api\/analyze-speech\/jobs\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && speechJobMatch) {
    return getSpeechJob(res, speechJobMatch[1]);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (pathname !== '/index.html') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.listen(port, '0.0.0.0', () => console.log(`朗思渡 listening on port ${port}`));
