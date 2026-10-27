const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {spawn}=require('node:child_process');
let upstream,child,base,calls=0;
const pcm=Buffer.alloc(64000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%200>100?1200:-1200,i);
const body={requestId:'dd9de325-fc36-4cd0-9edb-4079b6d908bc',audio:'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64'),consent:true,accent:'英式'};
before(async()=>{
 upstream=http.createServer(async(req,res)=>{calls++;let raw='';for await(const chunk of req)raw+=chunk;const sent=JSON.parse(raw);assert.equal(req.headers.authorization,'Bearer test-only-audio-key');assert.equal(sent.messages[0].content[0].input_audio.format,'wav');assert.equal(sent.messages[0].content.some(item=>item.text?.includes('REFERENCE SECRET')),false);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'{"status":"transcribed","transcript":"I has a coffee."}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),AUDIO_REVIEW_ENABLED:'true',AUDIO_REVIEW_API_URL:'http://127.0.0.1:'+upstream.address().port+'/chat/completions',AUDIO_REVIEW_API_KEY:'test-only-audio-key',AUDIO_REVIEW_MODEL:'qwen3.8-omni-flash'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('app startup failed');
});
after(async()=>{if(child?.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}if(upstream)await new Promise(r=>upstream.close(r));});
test('HTTP fallback requires consent, hides secrets, isolates browser records, and deduplicates billable calls',async()=>{
 const configResponse=await fetch(base+'/api/transcription/config'),config=await configResponse.json();assert.equal(config.enabled,true);assert.equal(config.minSeconds,1);assert.equal(JSON.stringify(config).includes('test-only-audio-key'),false);
 const cookie=configResponse.headers.get('set-cookie').split(';')[0],headers={'Content-Type':'application/json',Cookie:cookie};
 const denied=await fetch(base+'/api/transcription/jobs',{method:'POST',headers,body:JSON.stringify({...body,consent:false})});assert.equal(denied.status,400);assert.equal(calls,0);
 for(let n=0;n<2;n++){const response=await fetch(base+'/api/transcription/jobs',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,202);assert.equal((await response.json()).jobId,body.requestId);}
 assert.equal((await fetch(base+'/api/transcription/jobs/'+body.requestId)).status,404);
 let result;for(let n=0;n<30;n++){result=await(await fetch(base+'/api/transcription/jobs/'+body.requestId,{headers})).json();if(result.status!=='pending')break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(result.status,'complete');assert.equal(result.result.text,'I has a coffee.');assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('data:audio'),false);
 assert.ok((await fetch(base+'/health')).ok);
});
