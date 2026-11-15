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
test('the mascot and dedicated iPhone touch icon are served safely',async()=>{
 const asset=fs.readFileSync(path.join(directory,'assets','wolf-mascot.png'));
 const touchIcon=fs.readFileSync(path.join(directory,'assets','langsidu-apple-touch-icon.png'));
 assert.equal(asset.toString('hex',0,8),'89504e470d0a1a0a');
 assert.equal(touchIcon.toString('hex',0,8),'89504e470d0a1a0a');
 assert.equal(touchIcon.readUInt32BE(16),180);assert.equal(touchIcon.readUInt32BE(20),180);
 const page=fs.readFileSync(path.join(directory,'index.html'),'utf8');
 assert.match(page,/<link rel="icon" type="image\/png" sizes="192x192" href="\/assets\/langsidu-icon-192\.png">/);
 assert.match(page,/<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/langsidu-apple-touch-icon\.png">/);
 assert.equal((page.match(/\/assets\/wolf-mascot\.png\?v=7043ffd/g)||[]).length,6,'header, welcome, hero, empty-state and waiting art use the mascot');
 assert.match(page,/\.wolf-brand img\{width:48px;height:48px;object-fit:contain;background:transparent\}/,'the header logo keeps the transparent edges visible without a white tile');
 assert.doesNotMatch(page,/data:image\/svg\+xml;base64,/);
 const response=await fetch(base+'/assets/wolf-mascot.png?v=7043ffd'),served=Buffer.from(await response.arrayBuffer());
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/png/);assert.deepEqual(served,asset);
 const head=await fetch(base+'/assets/wolf-mascot.png',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(asset.length));
 const touchResponse=await fetch(base+'/assets/langsidu-apple-touch-icon.png'),servedTouchIcon=Buffer.from(await touchResponse.arrayBuffer());
 assert.equal(touchResponse.status,200);assert.match(touchResponse.headers.get('content-type'),/image\/png/);assert.deepEqual(servedTouchIcon,touchIcon);
 assert.equal((await fetch(base+'/assets/not-approved.png')).status,404);
 assert.ok((await fetch(base+'/health')).ok);
});

test('Android home screen manifest and all icon sizes are accessible',async()=>{
 const page=await (await fetch(base+'/')).text();
 assert.match(page,/<link rel="manifest" href="\/manifest\.webmanifest">/);
 const response=await fetch(base+'/manifest.webmanifest');
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/manifest\+json/);
 const manifest=await response.json();
 assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');
 assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'&&icon.purpose==='any'));
 assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512'&&icon.purpose==='any'));
 assert.ok(manifest.icons.some(icon=>icon.purpose==='maskable'));
 for(const icon of manifest.icons){
  const assetResponse=await fetch(base+icon.src),bytes=Buffer.from(await assetResponse.arrayBuffer());
  assert.equal(assetResponse.status,200);assert.match(assetResponse.headers.get('content-type'),/image\/png/);
  assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,icon.sizes);
  assert.deepEqual(bytes,fs.readFileSync(path.join(directory,icon.src)));
  const head=await fetch(base+icon.src,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));
 }
 assert.equal((await fetch(base+'/manifest.webmanifest',{method:'HEAD'})).status,200);
});
