const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const {createTopicGallery}=require('../topic-gallery');
const {categories}=require('../vision-result');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/z9sAAAAASUVORK5CYII=','base64');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-owner-gallery-'));fs.mkdirSync(path.join(root,'gallery','food'),{recursive:true});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manifestFile=path.join(root,'gallery','manifest.json');
  const write=themes=>fs.writeFileSync(manifestFile,JSON.stringify({version:1,themes}));
  const image=(name,bytes=png)=>fs.writeFileSync(path.join(root,'gallery',name),bytes);
  return {root,manifestFile,write,image};
}
test('production gallery preserves the owner archive theme assignments and only lists readable imported photos',()=>{
  const expected={'日常生活':39,'餐饮美食':21,'出行交通':38,'旅游观光':35,'工作职场':8,'休闲娱乐':102,'购物消费':11,'宠物动物':17,'运动健身':8,'自然风景':27,'学习校园':28,'医疗健康':0};
  const gallery=createTopicGallery(),data=gallery.list();assert.equal(data.themes.length,categories.length);
  assert.deepEqual(Object.fromEntries(data.themes.map(t=>[t.name,t.count])),expected);
  const directory=path.join(__dirname,'../gallery'),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  for(const theme of manifest.themes){
    const files=new Set();
    for(const entry of theme.images){
      assert.equal(entry.source.split('/')[0],theme.name);assert.equal(entry.file.split('/')[0],theme.name);
      assert.equal(path.parse(entry.file).name,path.parse(entry.source).name);assert.ok(!files.has(entry.file));files.add(entry.file);
      const bytes=fs.readFileSync(path.join(directory,entry.file));assert.ok(bytes.length>0&&bytes.length<=10*1024*1024);
      assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
    }
    if(theme.images.length){const first=gallery.select(theme.name);assert.equal(first.category,theme.name);assert.notEqual(gallery.select(theme.name,first.id).id,first.id);}
  }
  assert.throws(()=>gallery.select('医疗健康'),{status:404,code:'GALLERY_EMPTY'});
});
test('selected images belong exclusively to the requested theme and next selection excludes the last picture',t=>{
  const f=fixture(t);f.image('food/早餐（1）.png');f.image('food/002.png',Buffer.concat([png,Buffer.from('second')]));f.image('park.png');
  f.write([{name:'餐饮美食',images:[{file:'food/早餐（1）.png',label:'早餐'},'food/002.png']},{name:'自然风景',images:['park.png']}]);
  const gallery=createTopicGallery({root:f.root,randomIndex:()=>0});assert.equal(gallery.list().themes.find(t=>t.name==='餐饮美食').count,2);
  const first=gallery.select('餐饮美食'),second=gallery.select('餐饮美食',first.id);assert.equal(first.name,'早餐');assert.notEqual(first.id,second.id);assert.equal(second.category,'餐饮美食');assert.match(second.image,/^data:image\/png;base64,/);
  const only=gallery.select('自然风景');assert.equal(gallery.select('自然风景',only.id).repeated,true);
  assert.throws(()=>gallery.select('学习校园'),{code:'GALLERY_EMPTY'});assert.throws(()=>gallery.select('__random__'),{status:400});
});
test('missing files, path traversal, remote URLs and duplicate entries never become gallery pictures',t=>{
  const f=fixture(t);f.image('food/valid.png');fs.writeFileSync(path.join(f.root,'outside.png'),png);
  f.write([{name:'餐饮美食',images:['food/valid.png','food/valid.png','missing.jpg','../outside.png',path.join(f.root,'outside.png'),'https://example.com/photo.png']},{name:'学习校园',images:['../outside.png']}]);
  const gallery=createTopicGallery({root:f.root});assert.equal(gallery.list().themes.find(t=>t.name==='餐饮美食').count,1);assert.equal(gallery.list().themes.find(t=>t.name==='学习校园').count,0);
  assert.equal(Object.hasOwn(gallery.select('餐饮美食'),'file'),false);assert.throws(()=>gallery.select('学习校园'),{code:'GALLERY_EMPTY'});
});
test('invalid image bytes and malformed manifests produce explicit errors with no fallback',t=>{
  const f=fixture(t);f.image('food/broken.jpg',Buffer.from('<html>not a photo</html>'));f.write([{name:'餐饮美食',images:['food/broken.jpg']}]);
  const gallery=createTopicGallery({root:f.root});assert.throws(()=>gallery.select('餐饮美食'),{status:503,code:'GALLERY_UNAVAILABLE'});
  fs.writeFileSync(f.manifestFile,'not json');assert.throws(()=>gallery.list(),{status:503,code:'GALLERY_UNAVAILABLE'});
});

let child,provider,base,dir,calls=0,lastImage;
before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'langsidu-gallery-http-'));const gallery=path.join(dir,'gallery');fs.mkdirSync(gallery);
  fs.writeFileSync(path.join(gallery,'one.png'),png);fs.writeFileSync(path.join(gallery,'manifest.json'),JSON.stringify({themes:[{name:'餐饮美食',images:[{file:'one.png',label:'实物照片'}]}]}));
  provider=http.createServer(async(req,res)=>{calls++;const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));lastImage=body.messages[0].content.find(part=>part.type==='image_url').image_url.url;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({scene:'看图练习',category:'餐饮美食',elements:['杯子'],words:[{en:'cup',us:'/kʌp/',uk:'/kʌp/',zh:'杯子'}],phrases:[],sentences:[]})},finish_reason:'stop'}]}));});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),GALLERY_DIRECTORY:gallery,GALLERY_MANIFEST_FILE:path.join(gallery,'manifest.json'),USAGE_STATE_FILE:path.join(dir,'usage.json'),VISION_API_KEY:'test-key',VISION_API_URL:'http://127.0.0.1:'+provider.address().port,VISION_MODEL:'test-vision'},stdio:'ignore'});
  for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('HTTP test service did not start');
});
after(async()=>{if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}if(provider)await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});});
test('HTTP gallery selection makes zero model calls; selected image then goes through the unchanged vision API',async()=>{
  const count=calls;
  const catalog=await(await fetch(base+'/api/gallery')).json();assert.equal(catalog.themes.find(t=>t.name==='餐饮美食').count,1);
  const selected=await(await fetch(base+'/api/gallery/random?category='+encodeURIComponent('餐饮美食'))).json();assert.equal(calls,count);assert.match(selected.image,/^data:image\/png/);
  const usage=await fetch(base+'/api/practice-usage'),cookie=usage.headers.get('set-cookie').split(';')[0];assert.deepEqual((await usage.json()).used,{vision:0,speech:0});
  const response=await fetch(base+'/api/analyze-image',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({image:selected.image,accent:'英式'})});assert.equal(response.status,200);assert.equal((await response.json()).hints.words[0][0],'cup');assert.equal(lastImage,selected.image);assert.equal(calls,count+1);
  const used=await(await fetch(base+'/api/practice-usage',{headers:{Cookie:cookie}})).json();assert.equal(used.used.vision,1);assert.equal('scene' in used.limits,false);
});
test('empty themes and retired image-generation endpoints never call any provider',async()=>{
  const count=calls;const empty=await fetch(base+'/api/gallery/random?category='+encodeURIComponent('学习校园'));assert.equal(empty.status,404);assert.equal((await empty.json()).code,'GALLERY_EMPTY');
  for(const [method,url]of[['POST','/api/generate-scene/jobs'],['GET','/api/generate-scene/jobs/anything'],['GET','/api/scene-library']]){const response=await fetch(base+url,{method});assert.equal(response.status,410);assert.equal((await response.json()).code,'FEATURE_REMOVED');}
  assert.equal(calls,count);
});
