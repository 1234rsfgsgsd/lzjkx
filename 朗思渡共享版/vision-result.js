const categories = ['日常生活','餐饮美食','出行交通','旅游观光','工作职场','休闲娱乐','购物消费','宠物动物','运动健身','自然风景','学习校园','医疗健康'];

class VisionResultError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function parseVisionResult(result) {
  if (result.choices?.[0]?.finish_reason === 'length') {
    throw new VisionResultError('视觉模型输出被截断，请重试', 'VISION_OUTPUT_TRUNCATED');
  }
  let content = result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(part => part?.text || '').join('');
  const cleaned = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned); }
  catch { throw new VisionResultError('视觉模型没有返回完整的识别结果，请重试', 'VISION_INVALID_JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new VisionResultError('视觉模型返回内容为空，请重试', 'VISION_EMPTY_RESULT');
  const toPairs = (items, limit) => Array.isArray(items) ? items.map(item => {
    const values = Array.isArray(item) ? item : [item?.en, item?.us, item?.uk, item?.zh];
    return values.map(value => String(value || '').trim().slice(0, 120));
  }).filter(item => item[0] && item[3]).slice(0, limit) : [];
  const words = toPairs(parsed.words, 10);
  if (!words.length) throw new VisionResultError('视觉模型未生成照片关键词，请重试', 'VISION_EMPTY_WORDS');
  const elements = Array.isArray(parsed.elements)
    ? parsed.elements.map(value => String(value || '').trim().slice(0, 80)).filter(Boolean).slice(0, 10) : [];
  return {
    scene: String(parsed.scene || '照片场景').slice(0, 60),
    category: categories.includes(parsed.category) ? parsed.category : '日常生活',
    likelyIntent: String(parsed.likelyIntent || '描述画面').slice(0, 100),
    // Some providers omit elements but return genuine image-derived keywords.
    elements: elements.length ? elements : words.map(word => word[3]),
    hints: { words, phrases: toPairs(parsed.phrases, 5), sentences: toPairs(parsed.sentences, 3) },
    // These fields are advisory and are only used for AI-generated scene QA.
    // Missing fields remain null so ordinary uploaded-photo recognition keeps working.
    sceneMatch: typeof parsed.sceneMatch === 'boolean' ? parsed.sceneMatch : null,
    qualityOk: typeof parsed.qualityOk === 'boolean' ? parsed.qualityOk : null,
    qualityIssues: Array.isArray(parsed.qualityIssues)
      ? parsed.qualityIssues.map(value => String(value || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6)
      : [],
    visibleElements: Array.isArray(parsed.visibleElements)
      ? parsed.visibleElements.map(value => String(value || '').trim().slice(0, 80)).filter(Boolean).slice(0, 10)
      : []
  };
}

module.exports = { categories, parseVisionResult };
