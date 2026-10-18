const crypto = require('node:crypto');
const { categories } = require('./vision-result');

const maxImageBytes = 6 * 1024 * 1024;
const sceneStyles = {
  'teaching-photo': {
    prompt: 'a clear educational documentary photograph made for language practice, with one obvious subject and a simple uncluttered composition',
    negative: 'busy composition, too many people, crowded foreground, ambiguous action'
  },
  'daily-photo': {
    prompt: 'a natural everyday lifestyle photograph, like a carefully observed real moment in ordinary life, colorful but physically believable',
    negative: 'overly cinematic drama, staged fashion pose, cluttered composition'
  },
  'street-photo': {
    prompt: 'a realistic candid street photograph with authentic local details and natural ambient light, while keeping the main action easy to recognize',
    negative: 'tourist postcard, extreme wide angle, crowded frame, motion smear, confusing background'
  },
  'manga-comic': {
    prompt: 'an original full-colour manga-inspired illustration for language practice, with crisp expressive ink lines, clear storytelling, carefully designed characters and a readable everyday setting',
    negative: 'photorealism, muddy linework, excessive speed lines, extreme perspective, chibi proportions, fan art, copied character design'
  },
  'cartoon': {
    prompt: 'an original polished 2D cartoon illustration for language practice, with friendly expressive characters, rounded but coherent shapes, a rich cheerful colour palette and a clearly readable everyday action',
    negative: 'photorealism, 3d render, plastic surfaces, flat empty background, chaotic details, copied character design'
  }
};
const abstractElements = new Set(['氛围','感觉','体验','颜色','服务','热闹','满足','快乐','放松','安静','美丽','难忘','特别','方便','安全','效率','机会','挑战','进步','健康','温暖','清新','整洁','干净','舒适','幸福','选择','比较','满意','质量','品牌','价格','时间','方向','距离','速度','到达','出发','故事','文化','历史','心情','记忆','冒险','声音','气息','光线','空间','形状','环境','味道','香气','口感','温度']);
const contexts = {
  '日常生活': 'A real lived-in home, everyday furniture, fabrics and household belongings, relaxed ordinary life.',
  '餐饮美食': 'A real neighborhood restaurant or cafe, authentic food and appropriate tableware, customers and staff interacting naturally.',
  '出行交通': 'An ordinary commute or journey, accurate vehicles and station facilities, people naturally waiting or traveling.',
  '旅游观光': 'An authentic travel destination with local architecture, vegetation and environmental detail, casual tourists.',
  '工作职场': 'A real working environment with well-used office supplies and colleagues naturally communicating during an ordinary workday.',
  '休闲娱乐': 'An ordinary weekend or after-work activity with appropriate equipment, surroundings and natural body movements.',
  '购物消费': 'An authentic neighborhood shop or market, colorful products on shelves, a customer choosing products or talking with a shop assistant.',
  '宠物动物': 'An authentic environment appropriate for this animal, anatomically accurate species, natural animal behavior and everyday care.',
  '运动健身': 'An everyday sports venue with appropriate equipment and clothing, ordinary people exercising with accurate body movements.',
  '自然风景': 'A realistic natural landscape with seasonal vegetation, authentic terrain, weather and light; nature is the main subject.',
  '学习校园': 'Authentic everyday campus life, real books, backpacks or teaching equipment, students and teachers studying or talking naturally.',
  '医疗健康': 'A clean bright everyday healthcare setting, respectful professional interactions, fully clothed people, non-graphic routine care.'
};

const activities = {
  '咖啡厅': 'a customer ordering a latte from a barista at a cozy neighborhood cafe',
  '超市购物': 'a shopper comparing fresh produce beside a shopping cart in a neighborhood supermarket',
  '菜市场': 'a customer buying fresh vegetables from a vendor at a lively local produce market',
  '便利店': 'a customer paying a shop assistant at the checkout of a neighborhood convenience store',
  '服装店': 'a customer discussing the size of a shirt with a shop assistant in a clothing store',
  '图书馆': 'two students quietly discussing an open book at a library table with shelves of books behind them',
  '图书馆阅览室': 'students quietly reading at wooden library tables beside large windows and bookshelves',
  '教室上课': 'a teacher explaining a lesson to attentive students in a real classroom',
  '英语角': 'a small group of university students chatting casually together in a leafy campus courtyard',
  '宿舍生活': 'two students chatting and tidying their everyday belongings in a shared university dormitory',
  '校园食堂': 'students choosing lunch at a university cafeteria counter with trays of freshly cooked food',
  '自习室': 'students writing notes and reading books at a quiet study room table',
  '办公室办公': 'colleagues working at computers in a bright lived-in office with notebooks and plants',
  '会议室开会': 'three colleagues discussing a project around a meeting table with open notebooks and a laptop',
  '远程办公': 'a person working at a laptop on a home desk beside a window, with a notebook and coffee',
  '客厅休息': 'a person relaxing on a comfortable sofa at home with a cup of tea and a book',
  '厨房做饭': 'a person cooking a meal at a home kitchen counter with fresh vegetables and a pan on the stove',
  '书房阅读': 'a person reading a book at a wooden desk in a cozy home study',
  '阳台浇花': 'a person watering leafy plants and colorful flowers on a sunny apartment balcony',
  '打扫房间': 'a person cleaning the floor of a lived-in living room with everyday cleaning equipment',
  '公交车站': 'commuters waiting at a neighborhood bus stop as a city bus approaches',
  '地铁通勤': 'ordinary commuters standing and sitting inside a modern subway carriage',
  '机场候机': 'travelers waiting with carry-on suitcases beside large windows at an airport departure gate',
  '公园散步': 'two friends walking and talking along a tree-lined park path',
  '遛狗': 'a person walking a happy dog on a leash along a leafy neighborhood park path',
  '看医生': 'a doctor listening attentively to a fully clothed patient describing symptoms in a bright consultation room',
  '打篮球': 'friends playing a casual basketball game on a neighborhood outdoor court',
  '跑步': 'two amateur runners jogging on a leafy park path in soft morning light',
  '中餐馆': 'friends sharing a home-style Chinese meal with rice bowls and chopsticks at a small restaurant',
  '西餐厅': 'a waiter taking an order from two guests at a relaxed neighborhood restaurant'
};

function scenePrompt(scene, style = 'teaching-photo') {
  const preset = sceneStyles[style] || sceneStyles['teaching-photo'];
  const illustration = style === 'manga-comic' || style === 'cartoon';
  const medium = illustration ? 'a single coherent horizontal illustration' : 'a single continuous horizontal photograph';
  const elements = (Array.isArray(scene.elements) ? scene.elements : [])
    .filter(value => typeof value === 'string' && value.trim() && !abstractElements.has(value.trim()))
    .slice(0, 4);
  const props = elements.length ? `Only these supporting objects when they naturally belong to the activity: ${elements.join(', ')}.` : 'Use only a few objects that are genuinely needed for the activity.';
  return `${preset.prompt}. ${medium} showing ${activities[scene.name] || scene.name}. ${contexts[scene.category] || 'A realistic everyday setting.'} The exact activity above is the only story: one clear main action, zero to two people, and no unrelated events. ${props} Keep the subject centered and easy to recognize, with a calm eye-level composition, a distinct foreground, middle ground and background, and enough empty space around hands and faces. ${illustration ? 'Use believable lighting, clean edges, consistent character design, coherent hands and facial features, and a detailed but uncluttered background.' : 'Soft natural daylight, realistic shadows, true-to-life rich colors, and authentic skin, fabric and material detail.'} Natural expressions; people are engaged in the activity rather than posing. Use correct human anatomy, hands, fingers, object scale, perspective and contact with the ground. ${style === 'teaching-photo' ? 'Keep the background simple and readable for a language learner.' : ''}`;
}

function failure(message, status = 502, code = 'SCENE_GENERATION_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function sceneConfig(env) {
  let vision;
  try { vision = new URL(env.VISION_API_URL); } catch {}
  const silicon = vision && ['api.siliconflow.cn', 'api.siliconflow.com'].includes(vision.hostname);
  const apiUrl = env.SCENE_IMAGE_API_URL || (silicon ? `${vision.origin}/v1/images/generations` : '');
  let sameProvider = false;
  try { sameProvider = new URL(apiUrl).origin === vision?.origin; } catch {}
  return {
    apiUrl,
    apiKey: env.SCENE_IMAGE_API_KEY || (sameProvider ? env.VISION_API_KEY : ''),
    model: env.SCENE_IMAGE_MODEL || (silicon ? 'Tongyi-MAI/Z-Image-Turbo' : '')
  };
}

function createSceneGenerator(env = process.env) {
  const config = sceneConfig(env);
  const jobs = new Map();
  const clean = () => {
    for (const [id, job] of jobs) if (Date.now() - job.createdAt > 10 * 60_000) jobs.delete(id);
  };

  async function generate(scene) {
    const upstream = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model, prompt: scenePrompt(scene, scene.style), image_size: '1024x576',
        negative_prompt: `text, typography, title, subtitles, captions, letters, watermark, logo, poster, collage, cartoon, illustration, 3d render, geometric shapes, staged studio portrait, oversaturated colors, distorted anatomy, extra fingers, missing fingers, deformed hands, fused hands, melted faces, duplicate people, duplicate objects, floating objects, impossible object intersections, wrong perspective, inconsistent shadows, random unrelated props, surreal, fantasy, anatomical errors, ${sceneStyles[scene.style]?.negative || sceneStyles['teaching-photo'].negative}`
      }),
      signal: AbortSignal.timeout(120_000)
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch {}
    if (!upstream.ok) {
      const detail = String(data?.error?.message || data?.message || '服务商未提供详细原因')
        .replaceAll(config.apiKey, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/[\r\n\t]+/g, ' ').slice(0, 200);
      const guidance = [401, 403].includes(upstream.status)
        ? '请检查图片生成模型的调用权限、账户余额和密钥。'
        : upstream.status === 429 ? '请求较多，请稍后再试。' : '';
      throw failure(`场景图片生成失败（${upstream.status}）。${guidance}${detail}`, upstream.status === 429 ? 429 : 502);
    }
    const output = data?.images?.[0] || data?.data?.[0];
    if (typeof output?.b64_json === 'string') {
      if (output.b64_json.length > maxImageBytes * 1.4) throw failure('生成图片过大，请重新生成');
      const buffer = Buffer.from(output.b64_json, 'base64');
      return imageData(buffer);
    }
    let imageUrl;
    try { imageUrl = new URL(output?.url); } catch { throw failure('图片服务没有返回可用图片，请重试'); }
    const localTest = imageUrl.origin === new URL(config.apiUrl).origin && ['127.0.0.1', 'localhost'].includes(imageUrl.hostname);
    if (imageUrl.protocol !== 'https:' && !localTest) throw failure('图片服务返回的图片地址无效');
    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
    if (!imageResponse.ok) throw failure('图片已生成，但读取失败，请重新生成');
    // Keep the picture with the practice record instead of saving a provider URL that expires in one hour.
    const chunks = [];
    let size = 0;
    for await (const chunk of imageResponse.body) {
      size += chunk.length;
      if (size > maxImageBytes) throw failure('生成图片过大，请重新生成');
      chunks.push(chunk);
    }
    return imageData(Buffer.concat(chunks));
  }

  function imageData(buffer) {
    let mime;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg';
    else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
    else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    if (!mime || buffer.length > maxImageBytes) throw failure('图片服务返回的图片内容无效，请重试');
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  return {
    start(body) {
      clean();
      if (!config.apiKey || !config.apiUrl || !config.model) {
        throw failure('尚未配置场景图片生成服务。请在 Render 设置 SCENE_IMAGE_API_URL、SCENE_IMAGE_API_KEY 和 SCENE_IMAGE_MODEL。', 503, 'SCENE_NOT_CONFIGURED');
      }
      if (typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw failure('场景请求编号无效', 400);
      if (!categories.includes(body.category) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw failure('请选择有效的场景主题', 400);
      const style = sceneStyles[body.style] ? body.style : 'teaching-photo';
      const scene = {
        category: body.category, name: body.name.trim(),
        style,
        elements: Array.isArray(body.elements) ? body.elements.filter(v => typeof v === 'string').slice(0, 8).map(v => v.slice(0, 30)) : []
      };
      const signature = JSON.stringify(scene);
      const existing = jobs.get(body.requestId);
      if (existing) {
        if (existing.signature !== signature) throw failure('场景请求编号已使用，请重新生成', 409);
        return body.requestId;
      }
      if ([...jobs.values()].filter(job => job.status === 'pending').length >= 2) throw failure('场景生成任务较多，请稍后再试', 429);
      // Limit retained image data on the small shared server.
      if (jobs.size >= 12) {
        const oldest = [...jobs].find(([, job]) => job.status !== 'pending');
        if (oldest) jobs.delete(oldest[0]);
      }
      const job = { status: 'pending', createdAt: Date.now(), signature };
      jobs.set(body.requestId, job);
      generate(scene).then(image => {
        job.status = 'complete';
        job.result = { image, name: scene.name, category: scene.category, style: scene.style };
      }).catch(error => {
        job.status = 'failed';
        job.error = error.status ? error.message : ['TimeoutError', 'AbortError'].includes(error.name)
          ? '场景图片生成超时，请稍后重试' : '场景图片服务连接失败，请稍后重试';
        job.code = error.code || 'SCENE_GENERATION_ERROR';
      });
      return body.requestId;
    },
    get(id) {
      clean();
      const job = jobs.get(id);
      if (!job) throw failure('场景生成任务已过期或服务已重启，请重新生成', 404);
      return { status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error, code: job.code } : {}) };
    }
  };
}

module.exports = { createSceneGenerator, sceneConfig, scenePrompt, sceneStyles };
