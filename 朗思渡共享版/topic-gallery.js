const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {categories}=require('./vision-result');

// Only the owner's explicitly listed files are eligible. Never substitute a
// generated picture, another theme, a remote URL or a stock illustration.
function createTopicGallery({root=__dirname,directory=path.join(root,'gallery'),manifestFile=path.join(directory,'manifest.json'),randomIndex=n=>crypto.randomInt(n)}={}) {
  const base=path.resolve(directory);
  const inside=file=>file.startsWith(base+path.sep);
  function catalog(){
    let data;
    try{data=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}
    catch{throw Object.assign(new Error('主题图库配置暂时无法读取，请联系网站管理员；你仍可上传自己的照片。'),{status:503,code:'GALLERY_UNAVAILABLE'});}
    if(!Array.isArray(data.themes))throw Object.assign(new Error('主题图库配置无效，请联系网站管理员。'),{status:503,code:'GALLERY_UNAVAILABLE'});
    return categories.map(category=>{
      const theme=data.themes.find(item=>item.name===category);
      const images=[];
      for(const entry of Array.isArray(theme?.images)?theme.images:[]){
        const relative=typeof entry==='string'?entry:entry?.file;
        if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\0')||relative.split(/[\\/]+/).includes('..')||!/\.(?:jpe?g|png|webp)$/i.test(relative))continue;
        try{
          const resolved=fs.realpathSync(path.resolve(base,relative));
          if(!inside(resolved))continue;
          const stat=fs.statSync(resolved);if(!stat.isFile()||stat.size>10*1024*1024||stat.size===0)continue;
          const id=crypto.createHash('sha256').update(relative).digest('hex').slice(0,24);
          if(images.some(item=>item.id===id))continue;
          images.push({id,file:resolved,label:typeof entry?.label==='string'?entry.label.slice(0,100):category+'场景照片'});
        }catch{/* Missing photos do not become fake placeholders. */}
      }
      return {name:category,images};
    });
  }
  function list(){return {themes:catalog().map(theme=>({name:theme.name,count:theme.images.length}))};}
  function select(category,exclude=''){
    if(!categories.includes(category))throw Object.assign(new Error('请先选择一个有效主题。'),{status:400,code:'GALLERY_INVALID_THEME'});
    const theme=catalog().find(item=>item.name===category);
    const available=theme.images.length>1?theme.images.filter(item=>item.id!==exclude):theme.images;
    if(!available.length)throw Object.assign(new Error('“'+category+'”的图库照片还未添加。可以晚点再来，或先上传自己的照片练习。'),{status:404,code:'GALLERY_EMPTY'});
    const remaining=[...available];
    while(remaining.length){
      const item=remaining.splice(randomIndex(remaining.length),1)[0];
      try{
        const buffer=fs.readFileSync(item.file);let mime;
        if(buffer[0]===0xff&&buffer[1]===0xd8)mime='image/jpeg';
        else if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
        else if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')mime='image/webp';
        if(!mime||buffer.length>10*1024*1024)continue;
        return {id:item.id,name:item.label,category,count:theme.images.length,repeated:item.id===exclude,image:'data:'+mime+';base64,'+buffer.toString('base64')};
      }catch{/* A removed file cannot trigger a model call or cross-theme fallback. */}
    }
    throw Object.assign(new Error('这个主题的照片暂时无法读取，请联系管理员检查图库，或上传自己的照片。'),{status:503,code:'GALLERY_UNAVAILABLE'});
  }
  return {list,select};
}
module.exports={createTopicGallery};
