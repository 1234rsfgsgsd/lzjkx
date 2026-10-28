const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const directory=path.join(__dirname,'..');
let child,base,temp;
before(async()=>{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-wolf-'));const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[path.join(directory,'server.js')],{env:{...process.env,PORT:String(port),USAGE_STATE_FILE:path.join(temp,'usage.json'),XFYUN_USAGE_FILE:path.join(temp,'audio.json')},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}throw Error('mascot asset test server did not start');
});
after(async()=>{if(child?.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}if(temp)fs.rmSync(temp,{recursive:true,force:true});});
test('the hand-drawn transparent mascot is served safely as the logo, favicon and touch icon',async()=>{
 const asset=fs.readFileSync(path.join(directory,'assets','wolf-mascot.png'));
 assert.equal(asset.toString('hex',0,8),'89504e470d0a1a0a');
 const page=fs.readFileSync(path.join(directory,'index.html'),'utf8');
 assert.match(page,/<link rel="icon" type="image\/png" href="\/assets\/wolf-mascot\.png\?v=7043ffd">/);
 assert.match(page,/<link rel="apple-touch-icon" href="\/assets\/wolf-mascot\.png\?v=7043ffd">/);
 assert.equal((page.match(/\/assets\/wolf-mascot\.png\?v=7043ffd/g)||[]).length,8,'header, welcome, hero, empty-state, waiting art and browser icons all use one asset');
 assert.doesNotMatch(page,/data:image\/svg\+xml;base64,/);
 const response=await fetch(base+'/assets/wolf-mascot.png?v=7043ffd'),served=Buffer.from(await response.arrayBuffer());
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/png/);assert.deepEqual(served,asset);
 const head=await fetch(base+'/assets/wolf-mascot.png',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(asset.length));
 assert.equal((await fetch(base+'/assets/not-approved.png')).status,404);
 assert.ok((await fetch(base+'/health')).ok);
});
