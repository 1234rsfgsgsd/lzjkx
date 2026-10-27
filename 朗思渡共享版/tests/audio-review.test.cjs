const {test}=require('node:test');
const assert=require('node:assert/strict');
const {configuration,wavFromPcm,normalizeReview,createAudioReviewer}=require('../audio-review');
const {speechReport}=require('../oral-rubric');
const {createPronunciationJobs}=require('../pronunciation-jobs');
const env={AUDIO_REVIEW_ENABLED:'true',AUDIO_REVIEW_API_URL:'https://example.test/chat/completions',AUDIO_REVIEW_API_KEY:'private-test-key',AUDIO_REVIEW_MODEL:'audio-model'};
function review(){return {status:'scored',heardTranscript:'I would like a cup of coffee.',dimensions:Object.fromEntries(['prosody','intelligibility'].map((key,i)=>[key,{score:i?12:8,confidence:'medium',reason:'听到的重点和词句基本清楚',evidence:[{start:0.5,end:2,observation:'关键词清楚，结尾较平',suggestion:'按意群朗读，突出主要信息'}]}]))};}
const input={pcm:Buffer.alloc(96000,32),durationSeconds:3,accent:'英式',reference:'SECRET REFERENCE THAT MUST NOT BE SENT'};
const sse=(payload,finish='stop')=>new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(payload)},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
test('optional configuration hides credentials and starts disabled',()=>{assert.equal(configuration({}).enabled,false);assert.equal(configuration({...env,AUDIO_REVIEW_ENABLED:'false'}).enabled,false);assert.equal(configuration(env).enabled,true);assert.equal(JSON.stringify(configuration(env)).includes(env.AUDIO_REVIEW_API_KEY),false);});
test('audio request contains actual WAV bytes and accent, excludes reference and transcript, handles split SSE',async()=>{
 let calls=0;
 const reviewer=createAudioReviewer({env,fetchImpl:async(url,options)=>{calls++;assert.equal(String(url),env.AUDIO_REVIEW_API_URL);assert.equal(options.redirect,'error');const body=JSON.parse(options.body);assert.equal(body.stream,true);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.enable_thinking,false);assert.equal(JSON.stringify(body).includes(input.reference),false);assert.match(body.messages[0].content[1].text,/British/);const wav=Buffer.from(body.messages[0].content[0].input_audio.data.split(',')[1],'base64');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.deepEqual(wav.subarray(44),input.pcm);const bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'must never be returned',content:JSON.stringify(review())},finish_reason:'stop'}]})+'\r\n\r\ndata: [DONE]\r\n\r\n');return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=17)c.enqueue(bytes.slice(i,i+17));c.close();}}));}});
 const result=await reviewer.assess(input);assert.equal(calls,1);assert.equal(result.dimensions.prosody.score,8);assert.equal(result.dimensions.intelligibility.score,12);assert.equal(JSON.stringify(result).includes('must never be returned'),false);
});
test('missing evidence, low confidence, bad scores and out of range timestamps cannot fill scores',()=>{
 for(const change of [d=>d.confidence='low',d=>d.score=11,d=>d.score='8',d=>d.evidence=[],d=>d.evidence[0].end=3.1,d=>d.evidence[0].start=-1,d=>d.reason='']){const value=review();change(value.dimensions.prosody);const result=normalizeReview(JSON.stringify(value),3);assert.equal(result.dimensions.prosody.score,null);assert.equal(result.dimensions.intelligibility.score,12);}
 const silent=review();silent.status='insufficient';assert.equal(normalizeReview(JSON.stringify(silent),3).status,'insufficient');assert.throws(()=>normalizeReview('not JSON',3),{code:'AUDIO_REVIEW_INVALID'});
});
test('provider errors and truncated streams never retry or leak response bodies',async()=>{
 for(const response of [()=>new Response('secret provider details',{status:402}),()=>sse(review(),'length'),()=>new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\n')]){let calls=0;await assert.rejects(createAudioReviewer({env,fetchImpl:async()=>{calls++;return response();}}).assess(input),e=>e.code.startsWith('AUDIO_REVIEW_')&&!e.message.includes('secret provider details'));assert.equal(calls,1);}
});
test('combined reference score requires all eight dimensions and preserves unavailable or rejected audio',()=>{
 const acoustic={status:'scored',scores:{accuracy:80,fluency:80,integrity:100},metrics:{wpm:110},words:[]},text={grammar:80,vocabulary:80,topicRelevance:80},audio=normalizeReview(JSON.stringify(review()),3);
 const result=speechReport(acoustic,text,audio);assert.equal(result.coverage,'complete');assert.equal(result.aiReference,true);assert.equal(result.overallScore,82);assert.match(result.disclaimer,/未经人工校准/);
 assert.equal(speechReport(acoustic,null,audio).overallScore,null);assert.equal(speechReport(acoustic,text).overallScore,null);assert.equal(speechReport({...acoustic,status:'unscorable'},text,audio).dimensionScores.some(d=>d.score!==null),false);
});
test('job requires separate consent; supplemental failure preserves Xfyun and isolates job owner',async()=>{
 let calls=0;const reviewer={configuration:()=>({enabled:true}),assess:async()=>{calls++;throw Object.assign(new Error('百炼超时，讯飞结果仍保留。'),{code:'AUDIO_REVIEW_FAILED'});}},assessor={configuration:()=>({enabled:true}),assess:async()=>({status:'scored',scores:{accuracy:80,fluency:80,integrity:100},metrics:{wpm:110},words:[]})};
 const jobs=createPronunciationJobs({assessor,audioReviewer:reviewer,budget:{reserve(){}},evaluateText:async()=>({grammar:80,vocabulary:80,topicRelevance:80}),reserveUsage:()=>()=>{}}),user={id:'owner'};
 const body={requestId:'a467543b-2955-438a-bd75-fc734b6161ed',reference:'I like coffee.',text:'I like coffee.',audio:'data:audio/pcm;rate=16000;channels=1;base64,'+input.pcm.toString('base64')};
 jobs.start(body,user);await new Promise(r=>setImmediate(r));assert.equal(jobs.get(body.requestId,user).status,'complete');assert.equal(calls,0);
 assert.throws(()=>jobs.start({...body,audioReviewConsent:true},user),{code:'AUDIO_REQUEST_CONFLICT'});
 const second={...body,requestId:'d0bab575-d464-4a7a-9982-3c025b42bda0',audioReviewConsent:true};jobs.start(second,user);await new Promise(r=>setImmediate(r));const job=jobs.get(second.requestId,user);assert.equal(calls,1);assert.equal(job.status,'complete');assert.equal(job.result.report.dimensionScores[0].score,16);assert.match(job.result.audioReviewWarning,/超时/);assert.throws(()=>jobs.get(second.requestId,{id:'other'}),{code:'AUDIO_JOB_NOT_FOUND'});
});
