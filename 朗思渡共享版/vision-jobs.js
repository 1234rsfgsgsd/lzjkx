const crypto = require('node:crypto');

function createVisionJobs(analyze, { ttlMs = 10 * 60_000, maxJobs = 50 } = {}) {
  const jobs = new Map();
  function clean() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
  }
  function start(body) {
    clean();
    const id = typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId)
      ? body.requestId : crypto.randomUUID();
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      image: body.image, accent: body.accent, education: body.education,
      mode: body.mode, expectedScene: body.expectedScene, expectedCategory: body.expectedCategory
    })).digest('hex');
    if (jobs.has(id)) {
      if (jobs.get(id).fingerprint !== fingerprint) {
        throw Object.assign(new Error('识图任务编号已用于另一张图片，请重新提交'), { status: 409 });
      }
      return id;
    }
    if (jobs.size >= maxJobs) throw Object.assign(new Error('识图任务较多，请稍后再试'), { status: 503 });
    const job = { status: 'pending', fingerprint, createdAt: Date.now() };
    jobs.set(id, job);
    Promise.resolve().then(() => analyze(body)).then(result => {
      Object.assign(job, { status: 'complete', result, createdAt: Date.now() });
    }).catch(error => {
      const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
      console.error('Vision job failed', error.code || error.name || 'Error');
      Object.assign(job, {
        status: 'failed', createdAt: Date.now(),
        error: error.details || {
          error: error.status ? error.message : timedOut
            ? '视觉模型响应超时，请点击重新分析；无需重新生成图片'
            : '无法连接视觉模型服务，请稍后重新分析当前图片',
          code: timedOut ? 'VISION_TIMEOUT' : 'VISION_UNAVAILABLE', retryable: true
        }
      });
    });
    return id;
  }
  function get(id) {
    clean();
    const job = jobs.get(id);
    if (!job) throw Object.assign(new Error('识图任务已过期或服务已重启，请重新分析当前图片'), { status: 404 });
    if (job.status === 'complete') return { status: job.status, result: job.result };
    if (job.status === 'failed') return { status: job.status, ...job.error };
    return { status: 'pending' };
  }
  return { start, get };
}

module.exports = { createVisionJobs };
