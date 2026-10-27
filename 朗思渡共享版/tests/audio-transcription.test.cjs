const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRecording,normalizeTranscript,createTranscriber,createTranscriptionJobs}=require('../audio-transcription');
const pcm=Buffer.alloc(64000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%200>100?1500:-1500,i);
const body={requestId:'586432d0-6793-477b-a3f0-717b83d2fa2e',consent:true,audio:'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64'),accent:'英式'};
const env={AUDIO_REVIEW_ENABLED:'true',AUDIO_REVIEW_API_URL:'https://audio.example.test/v1/chat/completions',AUDIO_REVIEW_API_KEY:'secret-test-only',AUDIO_REVIEW_MODEL:'qwen3.8-omni-flash'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('transcription requires consent, real non-silent PCM, and valid duration; no reference is required',()=>{
 assert.throws(()=>validateRecording({...body,consent:false}),{code:'TRANSCRIPTION_CONSENT_REQUIRED'});
 assert.throws(()=>validateRecording({...body,audio:'data:audio/webm;base64,AAAA'}),{code:'TRANSCRIPTION_AUDIO_INVALID'});
 assert.throws(()=>validateRecording({...body,audio:'data:audio/pcm;rate=16000;channels=1;base64,'+Buffer.alloc(32000).toString('base64')}),{code:'TRANSCRIPTION_SILENT'});
 assert.throws(()=>validateRecording({...body,audio:'data:audio/pcm;rate=16000;channels=1;base64,AQ=='}),{code:'TRANSCRIPTION_DURATION_INVALID'});
 assert.deepEqual(validateRecording(body),{pcm,durationSeconds:2,accent:'英式'});
});
test('transcript parsing preserves learner errors and rejects empty, malformed and non-speech results',()=>{
 assert.equal(normalizeTranscript('{"status":"transcribed","transcript":"I has, um, a coffee."}').text,'I has, um, a coffee.');
 assert.throws(()=>normalizeTranscript('{"status":"no_speech","transcript":""}'),{code:'TRANSCRIPTION_NO_SPEECH'});
 assert.throws(()=>normalizeTranscript('{"status":"transcribed","transcript":"[unclear]"}'),{code:'TRANSCRIPTION_NO_SPEECH'});
 assert.throws(()=>normalizeTranscript('not JSON'),{code:'TRANSCRIPTION_RESULT_INVALID'});
});
test('provider request contains actual WAV, no reference script or grading prompt, and disables reasoning',async()=>{
 let calls=0;
 const transcriber=createTranscriber({env,fetchImpl:async(url,options)=>{
   calls++;assert.equal(url.href,env.AUDIO_REVIEW_API_URL);assert.equal(options.headers.Authorization,'Bearer secret-test-only');
   const sent=JSON.parse(options.body),content=sent.messages[0].content;
   assert.equal(sent.reasoning_effort,'none');assert.equal(sent.stream,true);assert.equal(sent.response_format.type,'json_object');
   assert.match(content[1].text,/Preserve the learner's grammar errors/);assert.doesNotMatch(content[1].text,/grade|0–10/);
   assert.equal(content[0].input_audio.format,'wav');assert.equal(Buffer.from(content[0].input_audio.data.split(',')[1],'base64').subarray(44).equals(pcm),true);
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{"status":"transcribed","transcript":"I has a coffee."}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 }});
 assert.equal(JSON.stringify(transcriber.configuration()).includes('secret-test-only'),false);
 assert.equal((await transcriber.transcribe(validateRecording(body))).text,'I has a coffee.');assert.equal(calls,1);
});
test('balance and network errors are safe and never automatically retried',async()=>{
 for(const mode of ['balance','network']){
  let calls=0;const transcriber=createTranscriber({env,fetchImpl:async()=>{calls++;if(mode==='network')throw new Error('secret-test-only');return new Response('private provider error',{status:402});}});
  await assert.rejects(()=>transcriber.transcribe(validateRecording(body)),error=>error.code.startsWith('TRANSCRIPTION_')&&!error.message.includes('secret-test-only'));
  assert.equal(calls,1);
 }
});
test('jobs isolate browsers, deduplicate lost submissions, reject conflicts and expire results',async()=>{
 let calls=0,time=1;const jobs=createTranscriptionJobs({now:()=>time,transcriber:{configuration:()=>({enabled:true}),transcribe:async()=>{calls++;return {text:'I has a coffee.'};}}}),owner={id:'one'},foreign={id:'two'};
 assert.equal(jobs.start(body,owner),body.requestId);assert.equal(jobs.start(body,owner),body.requestId);
 assert.throws(()=>jobs.get(body.requestId,foreign),{status:404});
 assert.throws(()=>jobs.start(body,foreign),{status:409});
 assert.throws(()=>jobs.start({...body,accent:'美式'},owner),{status:409});
 await settle();assert.equal(calls,1);assert.equal(jobs.get(body.requestId,owner).result.text,'I has a coffee.');
 time+=600001;assert.throws(()=>jobs.get(body.requestId,owner),{status:404});
});
test('provider failure preserves a failed job rather than resubmitting it',async()=>{
 let calls=0;const jobs=createTranscriptionJobs({transcriber:{configuration:()=>({enabled:true}),transcribe:async()=>{calls++;throw Object.assign(new Error('请稍后重试。'),{code:'TRANSCRIPTION_BUSY'});}}});
 jobs.start(body,{id:'owner'});await settle();assert.equal(jobs.get(body.requestId,{id:'owner'}).status,'failed');jobs.start(body,{id:'owner'});await settle();assert.equal(calls,1);
});
