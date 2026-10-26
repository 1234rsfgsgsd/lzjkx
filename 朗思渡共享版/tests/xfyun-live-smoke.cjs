const fs=require('node:fs');
const path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'..','.env.local'),quiet:true});
const {createXfyunAssessor,validateAudio}=require('../xfyun-ise');

function pcmFromWav(file){
  const wav=fs.readFileSync(file);
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw new Error('测试文件不是 WAV');
  let offset=12,format=null,data=null;
  while(offset+8<=wav.length){
    const id=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8;
    if(id==='fmt '){
      format={codec:wav.readUInt16LE(start),channels:wav.readUInt16LE(start+2),rate:wav.readUInt32LE(start+4),bits:wav.readUInt16LE(start+14)};
    }else if(id==='data')data=wav.subarray(start,start+size);
    offset=start+size+(size%2);
  }
  if(!format||format.codec!==1||format.channels!==1||format.rate!==16000||format.bits!==16||!data)throw new Error('测试 WAV 必须是 16kHz 单声道 16 位 PCM');
  return data;
}

async function main(){
  const file=process.argv[2],reference=process.argv.slice(3).join(' ').trim();
  if(!file||!reference)throw new Error('用法：node tests/xfyun-live-smoke.cjs <wav> <英文参考稿>');
  const pcm=pcmFromWav(file);
  const input=validateAudio({audio:'data:audio/pcm;rate=16000;channels=1;base64,'+pcm.toString('base64'),reference,accent:'美式'});
  const result=await createXfyunAssessor().assess(input);
  console.log(JSON.stringify({ok:true,status:result.status,scores:result.scores,metrics:result.metrics,wordCount:result.words.length},null,2));
}

main().catch(error=>{console.error(JSON.stringify({ok:false,code:error.code||'LIVE_TEST_FAILED',message:error.message}));process.exitCode=1;});
