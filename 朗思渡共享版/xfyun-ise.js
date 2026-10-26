const crypto=require('node:crypto');
const WebSocket=require('ws');
const {XMLParser,XMLValidator}=require('fast-xml-parser');
const MAX_SECONDS=180,MIN_SECONDS=3,SAMPLE_RATE=16000;
function failure(message,code='XFYUN_ERROR',status=502){return Object.assign(new Error(message),{code,status,retryable:false});}
function configuration(env=process.env){
  const configured=['XFYUN_APP_ID','XFYUN_API_KEY','XFYUN_API_SECRET'].every(key=>Boolean(env[key]?.trim()));
  return {enabled:env.XFYUN_ISE_ENABLED==='true'&&configured,configured,maxSeconds:MAX_SECONDS,minSeconds:MIN_SECONDS,provider:'讯飞语音评测（流式版）',accentSupport:'通用英语朗读评测；接口没有独立的英式/美式参数',capabilities:['pronunciation','fluency','word-alignment'],unavailable:['independent-prosody-score','independent-intelligibility-score']};
}
function validateAudio(body){
  const rawReference=typeof body.reference==='string'?body.reference.trim():'';
  if(!rawReference||rawReference.length>12000||!/[a-zA-Z]/.test(rawReference))throw failure('请先生成有效的英文润色稿，再评测第二次朗读。','AUDIO_REFERENCE_INVALID',400);
  const reference=rawReference.normalize('NFKC').replace(/[“”‘’]/g,"'").replace(/[‐‑‒–—−]/g,'-').replace(/…/g,'...').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\r\n?/g,'\n').split(/(?<=[.!?;])\s+/).map(part=>part.trim()).filter(Boolean);
  const wordCount=text=>((text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+/g))||[]).length;
  if(/[^\x20-\x7E\n\r\t]/.test(reference.join(' ')))throw failure('参考稿含讯飞不支持的字符，请先将非英文符号改写为普通英文字符。','AUDIO_REFERENCE_FORMAT_INVALID',400);
  if(Buffer.byteLength(reference.join(' '))>10000||wordCount(reference.join(' '))>1000||reference.some(sentence=>wordCount(sentence)>100||Buffer.byteLength(sentence)>1024))throw failure('讯飞篇章评测要求总词数不超过1000词，单句不超过100词或1024字节；请缩短超长句后再试。','AUDIO_REFERENCE_TOO_LONG',413);
  const paper=reference.join('\n');
  const match=typeof body.audio==='string'&&body.audio.match(/^data:audio\/pcm;rate=16000;channels=1;base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match||match[1].length>Math.ceil(MAX_SECONDS*SAMPLE_RATE*2/3)*4)throw failure('录音必须转换为16kHz、单声道、16位PCM，且不超过3分钟。','AUDIO_FORMAT_INVALID',400);
  const pcm=Buffer.from(match[1],'base64');
  if(pcm.length%2||pcm.toString('base64')!==match[1])throw failure('录音数据损坏，请重新录制。','AUDIO_FORMAT_INVALID',400);
  const durationSeconds=pcm.length/(SAMPLE_RATE*2);
  if(durationSeconds<MIN_SECONDS||durationSeconds>MAX_SECONDS)throw failure('请录制3秒至3分钟的有效英语朗读。','AUDIO_DURATION_INVALID',400);
  let energy=0;for(let i=0;i<pcm.length;i+=2)energy+=(pcm.readInt16LE(i)/32768)**2;
  if(Math.sqrt(energy/(pcm.length/2))<.0005)throw failure('录音几乎没有声音，请检查麦克风后重新录制。','AUDIO_SILENT',400);
  return {pcm,reference:paper,durationSeconds,accent:body.accent==='英式'?'英式':'美式'};
}
function signedUrl({apiKey,apiSecret,endpoint='wss://ise-api.xfyun.cn/v2/open-ise',now=new Date()}){
  const url=new URL(endpoint),date=now.toUTCString();
  const signature=crypto.createHmac('sha256',apiSecret).update('host: '+url.host+'\ndate: '+date+'\nGET '+url.pathname+' HTTP/1.1').digest('base64');
  const authorization=Buffer.from('api_key="'+apiKey+'", algorithm="hmac-sha256", headers="host date request-line", signature="'+signature+'"').toString('base64');
  url.searchParams.set('authorization',authorization);url.searchParams.set('date',date);url.searchParams.set('host',url.host);return url.toString();
}
const list=value=>value===undefined?[]:Array.isArray(value)?value:[value];
function nodes(value,name,result=[]){if(!value||typeof value!=='object')return result;for(const [key,item]of Object.entries(value)){if(key===name)result.push(...list(item));for(const nested of list(item))if(nested&&typeof nested==='object')nodes(nested,name,result);}return result;}
const number=value=>value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const score=value=>{const n=number(value);return n!==null&&n>=0&&n<=100?n:null;};
function parseResult(xml,{durationSeconds}){
  if(typeof xml!=='string'||Buffer.byteLength(xml)>2*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw failure('讯飞返回的语音评测结果无法解析，请保留录音后重试。','XFYUN_RESULT_INVALID');
  const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',parseAttributeValue:false,processEntities:false}).parse(xml);
  const chapters=nodes(parsed,'read_chapter'),chapter=chapters.find(n=>n['@_accuracy_score']!==undefined)||chapters.find(n=>n['@_total_score']!==undefined);
  if(!chapter)throw failure('讯飞没有返回篇章朗读的详细评测数据，请检查已开通的服务。','XFYUN_RESULT_INVALID');
  const rejected=['true','1'].includes(String(chapter['@_is_rejected']).toLowerCase());
  const exception=number(chapter['@_except_info']);
  if(rejected||(exception!==null&&exception!==0))return {status:'unscorable',scores:{},words:[],metrics:{durationSeconds},reason:'讯飞未接受本次有效朗读，可能是语音不足、噪声或与参考稿不匹配。请回听后重新录制。'};
  const scores={accuracy:score(chapter['@_accuracy_score']),fluency:score(chapter['@_fluency_score']),integrity:score(chapter['@_integrity_score']),total:score(chapter['@_total_score'])};
  if(scores.accuracy===null&&scores.fluency===null)throw failure('讯飞只返回了总分，缺少准确度和流利度；不会据此生成八项评分。','XFYUN_RESULT_INCOMPLETE');
  const words=nodes(chapter,'word').filter(n=>typeof n['@_content']==='string'&&/[a-zA-Z]/.test(n['@_content'])&&!/^\W*(?:sil|silv|fil|silence|sp|noise)\W*$/i.test(n['@_content'])).slice(0,2500).map(n=>{
    const start=number(n['@_beg_pos']),end=number(n['@_end_pos']),dp=number(n['@_dp_message'])||0;
    const aligned=start!==null&&end!==null&&start>=0&&end>start&&end/100<=durationSeconds+.2;
    const error=dp&16?'漏读':dp&32?'增读':dp&64?'回读':dp&128?'替换':score(n['@_total_score'])!==null&&score(n['@_total_score'])<60?'发音需核对':'';
    const syllables=nodes(n,'syll').slice(0,30).map(s=>({accent:number(s['@_syll_accent']),error:number(s['@_serr_msg'])||0}));
    const stressNeedsReview=syllables.some(s=>s.accent===1&&(s.error===2048||s.error===2049));
    return {text:n['@_content'].slice(0,100),score:score(n['@_total_score']),error,start:aligned?start/100:null,end:aligned?end/100:null,omitted:Boolean(dp&16),stressNeedsReview,phones:nodes(n,'phone').slice(0,20).map(p=>({symbol:String(p['@_content']||'').slice(0,40),errorCode:number(p['@_dp_message'])||0}))};
  });
  const aligned=words.filter(w=>!w.omitted&&w.start!==null).sort((a,b)=>a.start-b.start);
  const window=aligned.length?aligned.at(-1).end-aligned[0].start:0;
  const pauses=[];for(let i=1;i<aligned.length;i++){const gap=aligned[i].start-aligned[i-1].end;if(gap>2)pauses.push({start:aligned[i-1].end,end:aligned[i].start,seconds:Math.round(gap*100)/100});}
  const metrics={durationSeconds:Math.round(durationSeconds*100)/100,alignedWordCount:aligned.length,wpm:aligned.length>=3&&window>=2?Math.round(aligned.length/window*600)/10:null,alignedSpeechSeconds:aligned.length?Math.round(aligned.reduce((s,w)=>s+w.end-w.start,0)*100)/100:null,longPauseCount:aligned.length?pauses.length:null,longPauses:pauses,fillerCount:null,speedStability:null};
  return {status:scores.integrity!==null&&scores.integrity<30?'incomplete':'scored',scores,words,metrics,reason:scores.integrity!==null&&scores.integrity<30?'参考稿的有效朗读完成度不足30%，本次标记为未完成。':''};
}
function createXfyunAssessor({env=process.env,WebSocketClass=WebSocket,frameIntervalMs=40,now=()=>new Date()}={}){
  function assess(input){
    if(!configuration(env).enabled)return Promise.reject(failure('讯飞语音评测尚未启用，请先配置应用凭据并完成本地测试。','XFYUN_NOT_CONFIGURED',503));
    const {pcm,reference,durationSeconds}=input;
    return new Promise((resolve,reject)=>{
      let socket,settled=false,frameTimer,timeout,offset=0;
      function finish(error,result){if(settled)return;settled=true;clearTimeout(frameTimer);clearTimeout(timeout);if(socket?.readyState===WebSocket.OPEN)socket.close();else if(socket?.readyState===WebSocket.CONNECTING)socket.terminate();error?reject(error):resolve(result);}
      try{socket=new WebSocketClass(signedUrl({apiKey:env.XFYUN_API_KEY,apiSecret:env.XFYUN_API_SECRET,endpoint:env.XFYUN_ISE_URL||undefined,now:now()}),{handshakeTimeout:15000,maxPayload:3*1024*1024});}
      catch{return finish(failure('无法建立讯飞语音评测连接。','XFYUN_CONNECTION_FAILED'));}
      timeout=setTimeout(()=>finish(failure('讯飞语音评测等待超时，录音已保留；不会自动重复计费重试。','XFYUN_TIMEOUT',504)),Math.min(285000,durationSeconds*1000+45000));
      socket.on('error',()=>finish(failure('讯飞连接失败，请检查网络、应用鉴权和已开通的服务。','XFYUN_CONNECTION_FAILED')));
      socket.on('unexpected-response',(_req,res)=>{res.resume();finish(failure('讯飞拒绝了连接（'+res.statusCode+'），请检查应用密钥和服务权限。','XFYUN_AUTH_ERROR',502));});
      socket.on('close',()=>{if(!settled)finish(failure('讯飞连接提前关闭，没有收到完整评测；录音仍保留。','XFYUN_CONNECTION_CLOSED'));});
      socket.on('message',data=>{
        try{
          const message=JSON.parse(data.toString());
          if(message.code!==0){const code=String(message.code||'unknown');return finish(failure('讯飞语音评测返回错误码 '+code+'。请在讯飞控制台检查服务开通、调用额度与鉴权；本次不会自动重试。','XFYUN_PROVIDER_ERROR'));}
          if(Number(message.data?.status)===2){
            const encoded=message.data.data;if(typeof encoded!=='string'||!/^[A-Za-z0-9+/=]+$/.test(encoded))throw failure('讯飞未返回有效的语音评测结果。','XFYUN_RESULT_INVALID');
            finish(null,parseResult(Buffer.from(encoded,'base64').toString('utf8'),input));
          }
        }catch(error){finish(error.code?error:failure('讯飞返回的数据格式无效。','XFYUN_RESULT_INVALID'));}
      });
      socket.on('open',()=>{
        socket.send(JSON.stringify({common:{app_id:env.XFYUN_APP_ID},business:{sub:'ise',ent:'en_vip',category:'read_chapter',cmd:'ssb',aue:'raw',auf:'audio/L16;rate=16000',tte:'utf-8',rstcd:'utf8',ttp_skip:true,text:'\uFEFF[content]\n'+reference,ise_unite:'1',extra_ability:'multi_dimension;syll_phone_err_msg',rst:'entirety'},data:{status:0,data:''}}));
        function sendFrame(){
          if(settled||socket.readyState!==WebSocket.OPEN)return;
          if(offset>=pcm.length){socket.send(JSON.stringify({business:{cmd:'auw',aus:4,aue:'raw'},data:{status:2,data:'',data_type:1,encoding:'raw'}}));return;}
          const chunk=pcm.subarray(offset,offset+1280),first=offset===0;offset+=chunk.length;
          socket.send(JSON.stringify({business:{cmd:'auw',aus:first?1:2,aue:'raw'},data:{status:1,data:chunk.toString('base64'),data_type:1,encoding:'raw'}}));
          frameTimer=setTimeout(sendFrame,frameIntervalMs);
        }
        sendFrame();
      });
    });
  }
  return {assess,configuration:()=>configuration(env)};
}
module.exports={configuration,validateAudio,signedUrl,parseResult,createXfyunAssessor,MAX_SECONDS,MIN_SECONDS};
