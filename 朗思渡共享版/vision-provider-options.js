// Qwen's hybrid models accept this switch; dedicated VL Instruct models reject it.
function visionProviderOptions(apiUrl, model) {
  const host = new URL(apiUrl).hostname;
  return host === 'api.siliconflow.cn' && /(?:^|\/)Qwen3\.\d+-/i.test(model)
    ? { enable_thinking: false }
    : {};
}

module.exports = { visionProviderOptions };
