const fs=require('node:fs');
const path=require('node:path');
function createXfyunBudget({file,daily=20,monthly=100,now=()=>Date.now()}={}){
  let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  state ||= {day:'',month:'',dayUsed:0,monthUsed:0};
  const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!valid(state.dayUsed)||!valid(state.monthUsed))throw Error('讯飞调用计数文件损坏，请先核对用量。');
  function reset(){const date=new Date(now()+8*3600000).toISOString();if(state.day!==date.slice(0,10)){state.day=date.slice(0,10);state.dayUsed=0;}if(state.month!==date.slice(0,7)){state.month=date.slice(0,7);state.monthUsed=0;}}
  function view(){reset();return {...state,dailyLimit:daily,monthlyLimit:monthly,persistence:'仅对当前服务实例的本地计数有效；重新部署或多实例可能重置，供应商账单为准。'};}
  function reserve(){
    reset();if(state.dayUsed>=daily||state.monthUsed>=monthly)throw Object.assign(new Error('本站讯飞语音评测调用次数已达上限，本次不会提交录音。可回听录音或使用文本分析。'),{status:429,code:'XFYUN_CALL_LIMIT',retryable:false});
    const next={...state,dayUsed:state.dayUsed+1,monthUsed:state.monthUsed+1};
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(next));fs.renameSync(file+'.tmp',file);state=next;
    // Keep attempted provider calls counted even on failure: they may be billed.
  }
  return {view,reserve};
}
module.exports={createXfyunBudget};
