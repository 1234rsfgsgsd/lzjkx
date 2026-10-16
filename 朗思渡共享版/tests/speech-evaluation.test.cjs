const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countWords, scoreWeights, evaluationContext, evaluationPrompt, normalizeEvaluation } = require('../speech-evaluation');

test('word counts treat contractions and hyphenated compounds as one word', () => {
  assert.equal(countWords("I can't re-write it in 2026."), 6);
  assert.equal(countWords('I have a book.'), 4);
});

test('evaluation context sets a target range around the spoken transcript', () => {
  const text = 'I have dumplings. '.repeat(100);
  const context = evaluationContext({ text, accent: '英式', topic: { scene: '家庭聚餐', likelyIntent: '介绍食物', elements: ['饺子'] } });
  assert.equal(context.originalWordCount, 300);
  assert.equal(context.targetMinWords, 200);
  assert.equal(context.targetMaxWords, 400);
  assert.equal(context.accent, '英式');
  assert.equal(context.topic.scene, '家庭聚餐');
  assert.match(evaluationPrompt(context), /British English/);
  assert.match(evaluationPrompt(context), /200–400/);
});

test('normalization computes the weighted score and returns detailed feedback without an eight-error cap', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Mistake${i} happened.`).join(' ');
  const context = evaluationContext({ text, accent: '美式' });
  const parsed = {
    grammar: 60, topicRelevance: 90, coherence: 80, vocabulary: 70, fluency: 50,
    topicSummary: '讲述一次经历',
    keywords: [{ en: 'experience', zh: '经历' }], keyInformation: ['叙述者描述了一次经历。'],
    errors: Array.from({ length: 12 }, (_, i) => ({ original: `Mistake${i}`, correction: `Correction${i}`, explanation: '示例错误' })),
    styleSuggestions: [{ original: 'Mistake0', suggestion: 'An event', explanation: '更自然' }],
    polished: 'I described a meaningful experience with clear details.', summary: '测试总结'
  };
  const result = normalizeEvaluation(parsed, context);
  assert.equal(result.overall, 72);
  assert.deepEqual(scoreWeights, { grammar: 0.35, topicRelevance: 0.25, coherence: 0.2, vocabulary: 0.1, fluency: 0.1 });
  assert.equal(result.errors.length, 12);
  assert.equal(result.taskCompletion, 90);
  assert.equal(result.topicRelevance, 90);
  assert.equal(result.keywords[0].en, 'experience');
  assert.equal(result.styleSuggestions.length, 1);
  assert.equal(result.wordCountWithinRange, true);
});

test('normalization ignores corrections that do not quote the source and reports out-of-range output', () => {
  const context = evaluationContext({ text: 'I like dumplings very much. '.repeat(50) });
  const parsed = {
    grammar: 80, topicRelevance: 80, coherence: 80, vocabulary: 80, fluency: 80,
    errors: [{ original: 'invented fragment', correction: 'fixed fragment' }],
    polished: 'Dumplings are delicious.'
  };
  const result = normalizeEvaluation(parsed, context);
  assert.equal(result.errors.length, 0);
  assert.equal(result.wordCountWithinRange, false);
  assert.equal(result.overall, 80);
});
