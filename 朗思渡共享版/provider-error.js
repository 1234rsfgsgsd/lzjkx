function providerError(status, detail = '', service = 'AI') {
  const insufficient = status === 402 || /insufficient\s+(?:account\s+)?(?:balance|funds|credits?)|balance.*(?:insufficient|low|enough)|余额不足/i.test(detail);
  const error = insufficient ? 'AI 服务额度不足，请联系网站管理员补充额度。可先回听已保存的录音、查看文稿自行练习。'
    : [401, 403].includes(status) ? `${service}服务授权失败（${status}），请联系网站管理员检查密钥和模型权限。`
    : status === 429 ? `${service}服务请求较多，请稍后再试。`
    : `${service}服务暂时不可用（${status}），请稍后重新连接。`;
  return { error, code: insufficient ? 'AI_BALANCE_INSUFFICIENT' : [401,403].includes(status) ? 'AI_AUTH_ERROR' : status === 429 ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR', retryable: !insufficient && status >= 500 };
}
module.exports = { providerError };
