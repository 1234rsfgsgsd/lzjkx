const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.VISION_API_KEY;
const apiUrl = process.env.VISION_API_URL;
const model = process.env.VISION_MODEL;
const maxBytes = 10 * 1024 * 1024;
const maxBodyBytes = 15 * 1024 * 1024;
const trustedProxyHops = Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 1));
const windows = new Map();

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
  const hopIndex = forwarded.length - trustedProxyHops;
  const ip = trustedProxyHops > 0 && hopIndex > 0 ? forwarded[hopIndex - 1] : req.socket.remoteAddress;
  for (const [key, value] of windows) if (now - value.start > 120_000) windows.delete(key);
  const entry = windows.get(ip);
  if (!entry || now - entry.start > 60_000) windows.set(ip, { start: now, count: 1 });
  else if (++entry.count > 12) {
    send(res, 429, { error: '请求太频繁，请稍后再试' });
    return false;
  }
  return true;
}

async function analyze(req, res) {
  if (!apiKey || !apiUrl || !model) {
    send(res, 503, { error: '服务器还没有配置视觉模型服务' });
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

  const categories = ['日常生活','餐饮美食','出行交通','旅游观光','工作职场','休闲娱乐','购物消费','宠物动物','运动健身','自然风景','学习校园','医疗健康'];
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
      max_tokens: 600,
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
      : `视觉服务请求失败（${upstream.status}）：${providerMessage}`;
    send(res, 502, { error: guidance });
    return;
  }
  let content = result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(part => part?.text || '').join('');
  try {
    const cleaned = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const toPairs = (items, limit) => Array.isArray(items) ? items.map(item => [
      String(item?.en || '').trim().slice(0, 120),
      String(item?.us || '').trim().slice(0, 120),
      String(item?.uk || '').trim().slice(0, 120),
      String(item?.zh || '').trim().slice(0, 120)
    ]).filter(item => item[0] && item[3]).slice(0, limit) : [];
    const words = toPairs(parsed.words, 10);
    const phrases = toPairs(parsed.phrases, 5);
    const sentences = toPairs(parsed.sentences, 3);
    if (!words.length) throw new Error('incomplete coaching hints');
    send(res, 200, {
      scene: String(parsed.scene || '照片场景').slice(0, 60),
      category: categories.includes(parsed.category) ? parsed.category : '日常生活',
      likelyIntent: String(parsed.likelyIntent || '描述画面').slice(0, 100),
      elements: Array.isArray(parsed.elements) ? parsed.elements.map(value => String(value).trim().slice(0, 80)).filter(Boolean).slice(0, 10) : [],
      hints: { words, phrases, sentences }
    });
  } catch {
    send(res, 502, { error: '视觉模型返回的结果无法解析，请重试' });
  }
}

async function analyzeSpeech(req, res) {
  if (!apiKey || !apiUrl || !model) {
    send(res, 503, { error: '服务器还没有配置语言模型服务' });
    return;
  }
  const body = await readBody(req);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 6000) : '';
  if (!text) {
    send(res, 400, { error: '口述内容为空' });
    return;
  }
  const education = String(body.education || '大学及以上').slice(0, 60);
  const accent = body.accent === '英式' ? '英式英语' : '美式英语';
  const scene = String(body.scene || '一般口语练习').slice(0, 160);
  const prompt = `你是严格、具体、友善的英语口语评测老师。请分析学习者的英文口述，不要因为能理解就判定“没有错误”。区分真正错误（grammar、word_choice、word_form、article、preposition、tense、sentence_structure）和可选的自然表达建议。结合场景“${scene}”、学习阶段“${education}”，目标发音为“${accent}”。只返回严格 JSON，不要 markdown，不要补充说明。每项分数是0到100的整数：grammar语法准确度，vocabulary词汇，fluency流利度（根据文本的重复、停顿词和句子完整度推断），coherence连贯性，taskCompletion是否完成场景表达，overall为综合分。errors 是数组，每项包含 original（原文片段）、correction（修正片段）、category（错误类别）、explanation（中文解释）、severity（high/medium/low）；只列出确实存在的问题，最多8项。polished 必须保留原意、纠正错误并改成自然地道的${accent}表达，不要凭空增加事实；sentences 是适合逐句朗读的润色句子数组，每项包含 en 和 zh。格式：{"overall":0,"grammar":0,"vocabulary":0,"fluency":0,"coherence":0,"taskCompletion":0,"errors":[{"original":"","correction":"","category":"","explanation":"","severity":"medium"}],"polished":"","sentences":[{"en":"","zh":""}],"summary":""}。待评测口述：${text}`;
  const upstream = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.15, max_tokens: 900 }),
    signal: AbortSignal.timeout(100_000)
  });
  const responseText = await upstream.text();
  let result = {};
  try { result = JSON.parse(responseText); } catch {}
  if (!upstream.ok) {
    const providerMessage = String(result.error?.message || result.message || responseText || 'no response details')
      .replaceAll(apiKey, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
    console.error('Speech provider returned', upstream.status, providerMessage);
    send(res, 502, { error: `语言模型请求失败（${upstream.status}）：${providerMessage}` });
    return;
  }
  let content = result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(part => part?.text || '').join('');
  try {
    const cleaned = String(content || '').replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    const score = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(item => ({
      original: String(item?.original || '').slice(0, 180), correction: String(item?.correction || '').slice(0, 180),
      category: String(item?.category || '表达'), explanation: String(item?.explanation || '').slice(0, 240),
      severity: ['high', 'medium', 'low'].includes(item?.severity) ? item.severity : 'medium'
    })).filter(item => item.original && item.correction).slice(0, 8) : [];
    const sentences = Array.isArray(parsed.sentences) ? parsed.sentences.map(item => ({
      en: String(item?.en || '').trim().slice(0, 300), zh: String(item?.zh || '').trim().slice(0, 240)
    })).filter(item => item.en).slice(0, 8) : [];
    const polished = String(parsed.polished || '').trim().slice(0, 2500);
    if (!polished) throw new Error('incomplete speech evaluation');
    send(res, 200, {
      overall: score(parsed.overall), grammar: score(parsed.grammar), vocabulary: score(parsed.vocabulary),
      fluency: score(parsed.fluency), coherence: score(parsed.coherence), taskCompletion: score(parsed.taskCompletion),
      errors, polished, sentences, summary: String(parsed.summary || '').slice(0, 400)
    });
  } catch {
    send(res, 502, { error: '语言模型返回的评测结果无法解析，请重试' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
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
