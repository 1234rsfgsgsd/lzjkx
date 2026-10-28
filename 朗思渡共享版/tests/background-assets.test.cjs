const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');let child,base,tmp;
before(async()=>{tmp=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-bg-'));const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base='http://127.0.0.1:'+port;child=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),USAGE_STATE_FILE:path.join(tmp,'usage.json'),XFYUN_USAGE_FILE:path.join(tmp,'audio.json')},stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}throw Error('background asset server did not start');});
after(async()=>{if(child?.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}fs.rmSync(tmp,{recursive:true,force:true});});
test('welcome artwork and handwritten navigation icons are published without the second background',async()=>{
 const page=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.ok(page.includes('url("/assets/home-background.webp?v=5e22e999")'));
 assert.doesNotMatch(page,/app-background\.webp|nav-background\.webp|background-size:100% 100%/);
 for(const name of ['nav-icon-now.png','nav-icon-past.png','nav-icon-me.png']) assert.ok(page.includes(`/assets/${name}?v=20261028c`));
 assert.match(page,/mask-size:contain/);
 assert.match(page,/class="nav-item" data-nav="now" aria-label="NOW/);
 for(const name of ['home-background.webp','nav-icon-now.png','nav-icon-past.png','nav-icon-me.png']){const local=fs.readFileSync(path.join(root,'assets',name));assert.ok(local.length>1000);const response=await fetch(base+'/assets/'+name);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),name.endsWith('.png')?/image\/png/:/image\/webp/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),local);}
 assert.equal((await fetch(base+'/assets/unknown.webp')).status,404);
});
