const fs=require('node:fs'),path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'../.env.local'),quiet:true});
const {createAudioReviewer}=require('../audio-review');
async function main(){
 const file=process.argv[2];if(!file)throw Error('需要16kHz单声道16位PCM WAV测试录音路径');
 const wav=fs.readFileSync(file);if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('不是WAV文件');
 let pcm,format;for(let offset=12;offset+8<=wav.length;){const id=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8;if(start+size>wav.length)throw Error('WAV文件不完整');if(id==='fmt ')format={codec:wav.readUInt16LE(start),channels:wav.readUInt16LE(start+2),rate:wav.readUInt32LE(start+4),bits:wav.readUInt16LE(start+14)};if(id==='data')pcm=wav.subarray(start,start+size);offset=start+size+size%2;}
 if(!pcm||format?.codec!==1||format.channels!==1||format.rate!==16000||format.bits!==16)throw Error('需要16kHz单声道16位PCM');
 const durationSeconds=pcm.length/32000;if(durationSeconds<3||durationSeconds>180)throw Error('时长必须在3秒到3分钟');
 const result=await createAudioReviewer({env:{...process.env,AUDIO_REVIEW_ENABLED:'true'}}).assess({pcm,durationSeconds,accent:'美式'});
 console.log(JSON.stringify({ok:true,durationSeconds,result},null,2));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||'LIVE_TEST_FAILED',message:e.message}));process.exitCode=1;});
