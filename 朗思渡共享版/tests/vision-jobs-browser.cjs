const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'https://langsidu-sharing.onrender.com';
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const keywords = {
  scene: '桌前阅读', category: '学习校园', elements: ['书本'], likelyIntent: '介绍阅读',
  hints: { words: [['book', '/bʊk/', '/bʊk/', '书']], phrases: [], sentences: [] }
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const mode of ['upload', 'gallery', 'provider-error']) {
      const page = await browser.newPage({ viewport: { width: mode === 'gallery' ? 390 : 1280, height: 844 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('langsidu_state_v5', JSON.stringify({ skipWelcome: true })));
      await page.route('**/*', route => route.abort());
      await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto(origin + '/');
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
        return canvas.toDataURL('image/png');
      });
      let posts = 0, polls = 0, id, firstPayload;
      await page.route('**/api/analyze-image', async route => {
        posts++;
        const payload = route.request().postDataJSON();
        assert.equal(payload.async, true);
        assert.match(payload.image, /^data:image\/jpeg;base64,/);
        if (firstPayload) assert.equal(payload.requestId, firstPayload.requestId, 'resubmission keeps task identity');
        firstPayload = payload; id = payload.requestId;
        // Simulate a lost acknowledgement after the server accepted the task.
        if (posts === 1 && mode !== 'provider-error') return route.abort('connectionfailed');
        return route.fulfill({ status: 202, json: { jobId: id } });
      });
      await page.route('**/api/analyze-image/jobs/*', async route => {
        polls++;
        assert.ok(route.request().url().endsWith(id));
        if (mode === 'provider-error') return route.fulfill({ json: {
          status: 'failed', error: '视觉服务请求过多，请稍后再试', retryable: false, code: 'VISION_PROVIDER_ERROR'
        } });
        if (polls === 1) return route.abort('connectionfailed');
        if (polls === 2) return route.fulfill({ json: { status: 'pending' } });
        return route.fulfill({ json: { status: 'complete', result: keywords } });
      });
      await page.locator('[data-nav="now"]').click();
      if (mode === 'gallery') {
        await page.route('**/api/gallery/random?*',route=>route.fulfill({json:{id:'reading',name:'桌前阅读',category:'学习校园',image}}));
        await page.locator('[data-mode="gallery"]').click();
        await page.locator('#categoryGrid [data-category="学习校园"]').click();
      } else {
        await page.locator('[data-mode="upload"]').click();
        await page.locator('#photoInput').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
        await page.locator('#recognizeImageBtn').click();
      }
      if (mode === 'provider-error') {
        await page.waitForFunction(() => document.getElementById('uploadStatus').textContent.includes('请求过多'));
        assert.equal(posts, 1, 'provider failure is not resubmitted');
        assert.equal(await page.locator('#recognizeImageBtn').isEnabled(), true);
      } else {
        await page.waitForFunction(() => document.getElementById('hintList').textContent.includes('book'), null, { timeout: 20000 });
        assert.equal(posts, 2);
        assert.equal(polls, 3);
        assert.equal(await page.locator('#recordingSection').isVisible(), true);
        if (mode === 'gallery') {
          assert.equal(firstPayload.mode, undefined);
          assert.match(await page.locator('#photoPreview').getAttribute('src'), /^data:image\/jpeg;base64,/);
          assert.equal(await page.locator('#imageHintsStatus').getAttribute('aria-busy'), null);
        }
      }
      assert.deepEqual(errors, []);
      console.log('PASS vision jobs browser', mode);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
