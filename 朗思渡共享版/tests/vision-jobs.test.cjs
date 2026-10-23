const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createVisionJobs } = require('../vision-jobs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('disconnected clients reconnect to one vision task without another provider call', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = createVisionJobs(async () => { calls++; return gate; });
  const body = { requestId: randomUUID(), image: 'image-one', accent: '英式' };
  const id = jobs.start(body);
  assert.equal(jobs.start(body), id);
  assert.deepEqual(jobs.get(id), { status: 'pending' });
  assert.throws(() => jobs.start({ ...body, image: 'another-image' }), { status: 409 });
  await tick();
  assert.equal(calls, 1);
  release({ elements: ['书'], hints: { words: [['book']] } });
  await tick();
  assert.equal(jobs.get(id).status, 'complete');
  assert.equal(jobs.start(body), id);
  assert.equal(calls, 1);
  assert.equal('image' in jobs.get(id), false);
});

test('vision jobs retain provider permission and rate-limit details without retrying', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const details = { error: `provider ${status}`, code: 'VISION_PROVIDER_ERROR', retryable: false, retryAfterMs: 2000 };
    const jobs = createVisionJobs(async () => {
      calls++; throw Object.assign(new Error(details.error), { status, details });
    });
    const body = { requestId: randomUUID(), image: 'image' };
    const id = jobs.start(body);
    await tick();
    assert.deepEqual(jobs.get(id), { status: 'failed', ...details });
    assert.equal(jobs.start(body), id);
    assert.equal(calls, 1);
  }
});

test('vision timeout is explicit and unknown jobs cannot return invented results', async () => {
  const jobs = createVisionJobs(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  const id = jobs.start({ image: 'image' });
  await tick();
  assert.equal(jobs.get(id).code, 'VISION_TIMEOUT');
  assert.match(jobs.get(id).error, /无需重新生成图片/);
  assert.throws(() => jobs.get(randomUUID()), { status: 404 });
});
