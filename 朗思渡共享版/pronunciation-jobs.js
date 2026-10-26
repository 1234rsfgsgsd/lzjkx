const crypto=require('node:crypto');
const {validateAudio}=require('./xfyun-ise');
const {speechReport}=require('./oral-rubric');
const {evaluationContext}=require('./speech-evaluation');
function createPronunciationJobs({assessor,budget,evaluateText,reserveUsage,now=()=>Date.now()}={}){
  const jobs=new Map(),ttl=15*60000;
  function clean(){for(const [id,job]of jobs)if(now()-job.createdAt>ttl&&job.status!=='pending')jobs.delete(id);}
  function start(body,user){
    clean();if(!assessor.configuration().enabled)throw Object.assign(new Error('讯飞语音评测尚未启用。请由管理员配置凭据并完成测试；现有文本分析仍可用。'),{status:503,code:'XFYUN_NOT_CONFIGURED',retryable:false});
    const input=validateAudio(body),text=typeof body.text==='string'?body.text.trim():'';
    const context=text?evaluationContext({...body,text,phase:'final',reference:input.reference,rubric:'oral-v1'}):null;
    const fingerprint=crypto.createHash('sha256').update(input.pcm).update(JSON.stringify({reference:input.reference,accent:input.accent,context})).digest('hex');
    const requestId=typeof body.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(body.requestId)?body.requestId:null;
    if(!requestId)throw Object.assign(new Error('语音评测请求编号无效，请重新提交。'),{status:400,code:'AUDIO_REQUEST_INVALID'});
    if(jobs.has(requestId)){
      const job=jobs.get(requestId);
      if(job.owner!==user.id||job.fingerprint!==fingerprint)throw Object.assign(new Error('请求编号已用于另一份录音，请重新提交。'),{status:409,code:'AUDIO_REQUEST_CONFLICT'});
      return requestId;
    }
    if([...jobs.values()].filter(j=>j.status==='pending').length>=2||jobs.size>=50)throw Object.assign(new Error('当前语音评测任务较多，请稍后手动重试；本次未调用讯飞。'),{status:503,code:'AUDIO_BUSY',retryable:false});
    const refund=reserveUsage(user);
    try{budget.reserve();}catch(e){refund();throw e;}
    const job={owner:user.id,fingerprint,status:'pending',stage:'audio',createdAt:now()};jobs.set(requestId,job);
    Promise.resolve().then(async()=>{
      const acoustic=await assessor.assess(input);
      let textEvaluation=null,textWarning='';
      if(acoustic.status==='scored'&&context){
        job.stage='text';
        try{textEvaluation=await evaluateText({...body,text,phase:'final',reference:input.reference,rubric:'oral-v1'});}
        catch{textWarning='语音诊断已完成，但文字部分暂未完成；不会从参考稿代填语法、词汇和内容分数。';}
      }else if(!context)textWarning='没有第二次实际转写，本次只分析录音；语法、词汇和内容仍待评。';
      const report=speechReport(acoustic,textEvaluation);
      job.result={report,textEvaluation,textWarning,accent:input.accent,phase:'final'};job.status='complete';job.stage='complete';
    }).catch(error=>{refund();job.status='failed';job.error=error.code?.startsWith('XFYUN_')?error.message:'语音评测暂未完成，录音已保留；请稍后手动重试。';job.code=error.code||'AUDIO_ASSESSMENT_FAILED';job.retryable=false;});
    return requestId;
  }
  function get(id,user){
    clean();const job=jobs.get(id);
    if(!job||job.owner!==user.id)throw Object.assign(new Error('评测任务不存在或已过期，请使用原浏览器重新提交。'),{status:404,code:'AUDIO_JOB_NOT_FOUND'});
    return job.status==='complete'?{status:'complete',result:job.result}:job.status==='failed'?{status:'failed',error:job.error,code:job.code,retryable:false}:{status:'pending',stage:job.stage};
  }
  return {start,get};
}
module.exports={createPronunciationJobs};
