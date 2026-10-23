const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visionProviderOptions } = require('../vision-provider-options');

test('dedicated VL Instruct models receive no unsupported thinking switch', () => {
  for (const model of ['Qwen/Qwen3-VL-30B-A3B-Instruct', 'Qwen/Qwen3-VL-8B-Instruct']) {
    assert.deepEqual(visionProviderOptions('https://api.siliconflow.cn/v1/chat/completions', model), {});
  }
});

test('SiliconFlow hybrid Qwen models disable lengthy reasoning for picture keywords', () => {
  for (const model of ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B']) {
    assert.deepEqual(visionProviderOptions('https://api.siliconflow.cn/v1/chat/completions', model), { enable_thinking: false });
  }
  assert.deepEqual(visionProviderOptions('https://example.com/v1/chat/completions', 'Qwen/Qwen3.8-27B'), {});
});
