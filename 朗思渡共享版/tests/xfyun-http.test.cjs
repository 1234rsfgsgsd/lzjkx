const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {WebSocketServer}=require('ws');
let server,wss,child,base,dir,calls=0,textCalls=0,bytes;
const xml='<xml_result><read_chapter accuracy_score="85" fluency_score="75" integrity_score="100" total_score="80" is_rejected="false" except_info="0"><sentence><word content="I" beg_pos="10" end_pos="30" dp_message="0"/><word content="have" beg_pos="40" end_pos="90" dp_message="0"/><word content="coffee" beg_pos="100" end_pos="220" dp_message="128"/></sentence></read_chapter></xml_result>';
before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfyun-http-'));
  server=http.createServer(async(req,res)=>{textCalls++;let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.match(body.messages[0].content,/语法35%/);const parsed={grammar:80,vocabulary:70,topicRelevance:90,polished:'I have coffee.',scoreReasons:{grammar:'句式完整',vocabulary:'使用了咖啡词汇',topicRelevance:'完成主要信息'},scoreEvidence:{grammar:[{original:'I have coffee.',explanation:'基本语法正确'}]},errors:[]};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(parsed)},finish_reason:'stop'}]}));});
  wss=new WebSocketServer({server});wss.on('connection',(socket,req)=>{calls++;bytes=[];assert.ok(new URL(req.url,'http://localhost').searchParams.get('authorization'));socket.on('message',raw=>{const frame=JSON.parse(raw);if(frame.business?.aus===4)socket.send(JSON.stringify({code:0,data:{status:2,data:Buffer.from(xml).toString('base64')}}));else if(frame.business?.cmd==='auw')bytes.push(Buffer.from(frame.data.data,'base64'));else{assert.equal(frame.business.category,'read_chapter');assert.match(frame.business.extra_ability,/multi_dimension/);}});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
  const provider='127.0.0.1:'+server.address().port;
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),VISION_API_KEY:'text-secret',VISION_API_URL:'http://'+provider+'/text',VISION_MODEL:'text-model',XFYUN_ISE_ENABLED:'true',XFYUN_APP_ID:'app',XFYUN_API_KEY:'audio-key',XFYUN_API_SECRET:'audio-secret',XFYUN_ISE_URL:'ws://'+provider+'/v2/open-ise',XFYUN_USAGE_FILE:path.join(dir,'audio-usage.json'),USAGE_STATE_FILE:path.join(dir,'usage.json')},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('HTTP test app did not start');
});
after(async()=>{if(child?.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}for(const socket of wss?.clients||[])socket.terminate();if(wss)await new Promise(r=>wss.close(r));if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
test('HTTP audio route validates input, streams actual PCM, isolates job ownership, deduplicates and permits additional provider calls',async()=>{
  const config=await(await fetch(base+'/api/pronunciation/config')).json();assert.equal(config.enabled,true);assert.equal(config.maxSeconds,180);assert.equal(JSON.stringify(config).includes('audio-secret'),false);
  const pcm=Buffer.alloc(3*16000*2);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%200>100?1000:-1000,i);
  const body={requestId:'cdd836f5-074d-4b6a-b34d-99866d90637e',audio:'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64'),reference:'I have coffee.',text:'I have coffee.',accent:'英式'};
  const invalid=await fetch(base+'/api/pronunciation/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,audio:'data:audio/webm;base64,AAAA'})});assert.equal(invalid.status,400);assert.equal(calls,0);
  const response=await fetch(base+'/api/pronunciation/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,202);const cookie=response.headers.get('set-cookie').split(';')[0],headers={'Content-Type':'application/json',Cookie:cookie};
  assert.equal((await fetch(base+'/api/pronunciation/jobs',{method:'POST',headers,body:JSON.stringify(body)})).status,202);
  const foreign=await fetch(base+'/api/pronunciation/jobs/'+body.requestId);assert.equal(foreign.status,404);
  let job;for(let n=0;n<40;n++){job=await(await fetch(base+'/api/pronunciation/jobs/'+body.requestId,{headers})).json();if(job.status!=='pending')break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(job.status,'complete');assert.equal(calls,1);assert.equal(textCalls,1);assert.deepEqual(Buffer.concat(bytes),pcm);assert.equal(job.result.report.mode,'speech');assert.equal(job.result.report.overallScore,null);assert.equal(job.result.report.dimensionScores.find(d=>d.key==='grammar').score,8);assert.equal(job.result.report.dimensionScores.find(d=>d.key==='prosody').score,null);
  const secondId='1a7f84eb-622d-4152-a8b0-85c359c78379';const second=await fetch(base+'/api/pronunciation/jobs',{method:'POST',headers,body:JSON.stringify({...body,requestId:secondId})});assert.equal(second.status,202);for(let n=0;n<40&&calls<2;n++)await new Promise(r=>setTimeout(r,200));assert.equal(calls,2);
  const usage=await(await fetch(base+'/api/practice-usage',{headers})).json();assert.equal(usage.used.speech,2);
  assert.ok((await fetch(base+'/health')).ok);const gallery=await(await fetch(base+'/api/gallery')).json();assert.equal(gallery.themes.length,12);
});
