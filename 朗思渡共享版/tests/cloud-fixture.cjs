const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {createCloudAccounts}=require('../cloud-accounts');

async function fixture({directory,now,secureCookie=false}={}){
  const db=new PGlite(directory);
  const accounts=createCloudAccounts({db,now,secureCookie});
  await accounts.ready();
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://'+req.headers.host);
    if(await accounts.handle(req,res,url))return;
    if(url.pathname==='/'){
      const html=(await fs.readFile(path.join(__dirname,'../index.html'),'utf8')).replace('data-cloud-accounts="false"','data-cloud-accounts="true"');
      res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
    }
    if(url.pathname.startsWith('/assets/')&&!url.pathname.includes('..')){
      try{const content=await fs.readFile(path.join(__dirname,'..',url.pathname));res.setHeader('Content-Type',url.pathname.endsWith('.webp')?'image/webp':'image/png');return res.end(content);}catch{}
    }
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/practice-usage')return res.end(JSON.stringify({used:{vision:0,speech:0},limits:{vision:20,speech:20},scope:'浏览器'}));
    if(url.pathname==='/api/gallery')return res.end('{"themes":[]}');
    if(url.pathname==='/api/pronunciation/config')return res.end('{"enabled":false}');
    res.statusCode=404;res.end('{"error":"fixture endpoint unavailable"}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(route,{method='GET',body,cookie,headers={}}={}){
    const response=await fetch(origin+route,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-Langsidu-Request':'account'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  return {db,accounts,origin,request,async close(){await new Promise(resolve=>server.close(resolve));await accounts.close();}};
}
const registration=(nickname='Alice')=>({nickname,password:'English123',confirmPassword:'English123',settings:{prefs:{accent:'英式',purpose:'旅游',education:'高中'}}});
const record=(id=1)=>({id,time:'2026/11/2',sceneName:'Cafe',sceneCategory:'餐饮美食',transcript:'I has coffee.',corrected:'I have coffee.',audio:'data:audio/webm;codecs=opus;base64,dGVzdA==',rereadAudio:'data:audio/mp4;base64,dHdv',image:'data:image/png;base64,dGVzdA==',rereadTranscript:'I have coffee.'});
module.exports={fixture,registration,record};
