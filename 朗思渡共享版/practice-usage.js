const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// This is a browser allowance, not an account identity. Render's ephemeral disk resets on redeploy.
function createPracticeUsage({ file, limits = { scene: 6, vision: 20, speech: 20 }, now = () => Date.now() }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ||= { secret: crypto.randomBytes(32).toString('hex'), day: '', entries: {} };
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
  }
  function reset() {
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0,10);
    if (state.day !== day) { state.day = day; state.entries = {}; save(); }
  }
  function signature(id) { return crypto.createHmac('sha256', state.secret).update(id).digest('hex'); }
  function identity(req, res) {
    reset();
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)langsidu_device=([a-f0-9-]+)\.([a-f0-9]+)/);
    let id = cookie?.[1];
    if (!id || cookie[2] !== signature(id)) {
      id = crypto.randomUUID();
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `langsidu_device=${id}.${signature(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    const ip = req.practiceIp || req.socket.remoteAddress || 'unknown';
    return { id, ip: crypto.createHmac('sha256', state.secret).update(ip).digest('hex') };
  }
  function view(user) {
    reset();
    return { day: state.day, resetTime: '北京时间次日 00:00', limits, used: Object.fromEntries(Object.keys(limits).map(k => [k, state.entries['device:' + user.id]?.[k] || 0])), scope: '当前浏览器；同一网络另有共享上限。服务重新部署时可能重置。' };
  }
  function reserve(user, kind) {
    reset();
    const keys = ['device:' + user.id, 'network:' + user.ip];
    for (const [i,key] of keys.entries()) {
      if ((state.entries[key]?.[kind] || 0) >= limits[kind] * (i ? 5 : 1)) {
        throw Object.assign(new Error(i ? '当前网络今日的 AI 使用次数已用完，请明天再试，或使用免费场景图库。' : '当前浏览器今日的 AI 使用次数已用完，请明天再试，或使用免费场景图库。'), { status: 429, code:'DAILY_QUOTA', details:{error:'今日 AI 使用次数已用完，请明天再试，或使用免费场景图库。',code:'DAILY_QUOTA',retryable:false} });
      }
    }
    for (const key of keys) { state.entries[key] ||= {}; state.entries[key][kind] = (state.entries[key][kind] || 0) + 1; }
    save();
    const day = state.day; let refunded = false;
    return () => {
      if (refunded || state.day !== day) return;
      refunded = true;
      for (const key of keys) state.entries[key][kind] = Math.max(0, state.entries[key][kind] - 1);
      save();
    };
  }
  return { identity, view, reserve };
}
module.exports = { createPracticeUsage };
