const fs=require('node:fs');
const path=require('node:path');
function createXfyunBudget({file,now=()=>Date.now()}={}){
  let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  state ||= {day:'',month:'',dayUsed:0,monthUsed:0};
  const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!valid(state.dayUsed)||!valid(state.monthUsed))throw Error('讯飞调用计数文件损坏，请先核对用量。');
  function reset(){const date=new Date(now()+8*3600000).toISOString();if(state.day!==date.slice(0,10)){state.day=date.slice(0,10);state.dayUsed=0;}if(state.month!==date.slice(0,7)){state.month=date.slice(0,7);state.monthUsed=0;}}
  function view(){reset();return {...state,persistence:'仅记录本站实例已提交的调用次数；不设置本站硬上限，供应商额度、余额和计费规则为准。'};}
  function reserve(){
    reset();
    const next={...state,dayUsed:state.dayUsed+1,monthUsed:state.monthUsed+1};
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(next));fs.renameSync(file+'.tmp',file);state=next;
    // Keep attempted provider calls counted even on failure: they may be billed.
  }
  return {view,reserve};
}
module.exports={createXfyunBudget};
