const crypto = require('node:crypto');
const { categories } = require('./vision-result');

const maxImageBytes = 6 * 1024 * 1024;
const contexts = {
  '日常生活': '真实有人居住的家庭，日常使用的家具、织物和生活用品，随意自然的生活状态',
  '餐饮美食': '真实街区里的餐馆或咖啡馆，符合这道食物的餐具和食材，顾客与店员自然互动',
  '出行交通': '日常通勤或旅行途中，准确的交通工具与站点设施，人们自然候车或出行',
  '旅游观光': '普通人旅途中真实可见的地点，当地建筑、植被和环境细节，自然的游客活动',
  '工作职场': '真实现代工作环境，使用中的办公用品，同事间自然交流，普通日常工作状态',
  '休闲娱乐': '平常周末或下班后的休闲活动，符合活动的场地、道具和自然动作',
  '购物消费': '真实社区商店或市场，整齐但有生活气息的商品陈列，顾客挑选商品或与店员交谈',
  '宠物动物': '符合动物习性的真实生活环境，准确的物种外观，自然的动物动作与日常照料细节',
  '运动健身': '日常运动场或健身空间，符合运动的器材、服装和准确身体动作，普通运动爱好者',
  '自然风景': '真实自然环境和符合季节天气的植被、地貌与光线，画面以自然景物为主',
  '学习校园': '真实校园学习生活，正常使用的课本、书包或教学设施，师生自然学习与交流',
  '医疗健康': '干净明亮的真实医疗或健康环境，自然且尊重隐私的医患沟通，非血腥的日常场景'
};

function scenePrompt(scene) {
  return `一张真实生活摄影风格的横向照片，用于英语看图口语练习。唯一核心场景：${scene.name}。主题：${scene.category}。${contexts[scene.category]}。场景必须准确体现“${scene.name}”这项活动，不要换成该主题的其他活动。可参考的细节：${scene.elements.join('、')}；仅在符合该活动时加入具体可见物品，抽象感受用光线和动作表达。人物出现时采用自然的表情、准确的肢体和可信的互动，不看镜头摆拍；画面中有一个清晰的主要动作。中景或环境人像构图，前景、中景和背景具有真实空间关系；真实材料纹理、柔和自然光、自然阴影，色彩丰富但真实，保留暖木色、绿色植物、衣物和物品的色彩层次。像生活纪实照片，细节清晰，适合描述人物、动作、物品和环境。不要绘制说明文字、标题、水印、拼贴或海报；不要卡通、插画、3D渲染、几何色块或过度磨皮。`;
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
      body: JSON.stringify({ model: config.model, prompt: scenePrompt(scene), image_size: '1024x576' }),
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
      const scene = {
        category: body.category, name: body.name.trim(),
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
        job.result = { image, name: scene.name, category: scene.category };
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

module.exports = { createSceneGenerator, sceneConfig, scenePrompt };
