const fs=require('node:fs'),path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'../.env.local'),quiet:true});
const {validateRecording,createTranscriber}=require('../audio-transcription');
async function main(){
 const file=process.argv[2];if(!file)throw Error('需要16kHz单声道16位PCM测试文件路径');
 const pcm=fs.readFileSync(file),input=validateRecording({consent:true,audio:'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64'),accent:'英式'});
 const transcriber=createTranscriber();if(!transcriber.configuration().enabled)throw Error('云端转写未启用');
 const result=await transcriber.transcribe(input);console.log(JSON.stringify({ok:true,durationSeconds:input.durationSeconds,...result}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:error.code||'LIVE_TEST_FAILED',message:error.message}));process.exitCode=1;});
