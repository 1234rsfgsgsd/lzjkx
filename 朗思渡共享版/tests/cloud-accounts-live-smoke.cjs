// Explicit live test: uses DATABASE_URL, creates two synthetic users, then removes only those users.
// No AI/model calls or real user recordings are made. Never print the database URL or session tokens.
const {Pool}=require('pg');
const crypto=require('node:crypto');
const http=require('node:http');
const {spawn}=require('node:child_process');
const path=require('node:path');
const assert=require('node:assert/strict');
const {record}=require('./cloud-fixture.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function testAudio(frequency){
  const rate=16000,buffer=Buffer.alloc(44+rate*2);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(rate*2,40);
  for(let i=0;i<rate;i++)buffer.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*frequency*i/rate)),44+i*2);
  return 'data:audio/wav;base64,'+buffer.toString('base64');
}

(async()=>{
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required for this explicit live test');
  const db=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:15000});
  let child,origin=process.env.CLOUD_SMOKE_ORIGIN;
  const local=!origin;
  const names=['QA'+crypto.randomBytes(7).toString('hex'),'QA'+crypto.randomBytes(7).toString('hex')];
  const password='Aa9'+crypto.randomBytes(18).toString('base64url');
  const sample={...record(),audio:testAudio(440),rereadAudio:testAudio(660),image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/z9sAAAAASUVORK5CYII='};
  async function start(){
    const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));origin='http://127.0.0.1:'+port;
    child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port)},stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',()=>{});
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw new Error('Local server stopped');
      try{if((await fetch(origin+'/health')).ok)return;}catch{}
      await delay(100);
    }
    throw new Error('Local server did not start');
  }
  async function stop(){if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}child=null;}
  async function api(route,{method='GET',body,cookie}={}){
    const response=await fetch(origin+route,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-Langsidu-Request':'account'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    await db.query('SELECT 1');if(local)await start();
    assert.equal((await api('/api/auth/config')).data.enabled,true);
    const accounts=[];
    for(const nickname of names){const result=await api('/api/auth/register',{method:'POST',body:{nickname,password,confirmPassword:password,settings:{prefs:{accent:'英式',purpose:'旅游'}}}});assert.equal(result.status,200);accounts.push(result);}
    const alice=accounts[0].cookie,bob=accounts[1].cookie;
    assert.equal((await api('/api/account/history')).status,401);
    assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:names[0],password:'Wrong123'}})).status,401);
    const login=await api('/api/auth/login',{method:'POST',body:{nickname:names[0],password}});assert.equal(login.status,200);
    const saved=await api('/api/account/history',{method:'PUT',body:{records:[sample],revision:0},cookie:alice});assert.equal(saved.status,200);
    const reading=await api('/api/account/history',{cookie:login.cookie});assert.equal(reading.data.records[0].audio,sample.audio);assert.equal(reading.data.records[0].rereadAudio,sample.rereadAudio);
    assert.deepEqual((await api('/api/account/history?userId='+accounts[0].data.user.id,{cookie:bob})).data.records,[]);
    assert.equal((await api('/api/account/history',{method:'PUT',body:{records:[],revision:0},cookie:alice})).status,409);
    if(local){await stop();await start();}
    assert.deepEqual((await api('/api/account/history',{cookie:alice})).data,reading.data);
    assert.equal((await api('/api/auth/me',{cookie:alice})).data.user.settings.prefs.accent,'英式');
    if(process.env.CLOUD_SMOKE_BROWSER==='true'){
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
      const browser=await chromium.launch({channel:'msedge',headless:true});
      try{
        for(let i=0;i<names.length;i++){
          const context=await browser.newContext();const page=await context.newPage();
          await page.goto(origin);await page.getByRole('button',{name:'开始',exact:true}).click();await page.getByRole('button',{name:'已经注册账号',exact:true}).click();
          await page.locator('#accountNickname').fill(names[i]);await page.locator('#accountPassword').fill(password);await page.locator('#accountSubmit').click();await page.locator('#welcomeOverlay').waitFor({state:'hidden'});await page.locator('[data-nav="past"]').click();
          if(i===0){await page.locator('.history-item').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.history-item audio')].length===2&&[...document.querySelectorAll('.history-item audio')].every(a=>Math.abs(a.duration-1)<.01));}
          else assert.equal(await page.locator('.history-item').count(),0);
          await context.close();
        }
        console.log('PASS real database browser login: two private accounts and decodable saved audio on a fresh device');
      }finally{await browser.close();}
    }
    const stored=await db.query('SELECT password_hash FROM langsidu_users WHERE username=$1',[names[0].toLowerCase()]);assert.ok(stored.rows[0].password_hash!==password);
    await api('/api/auth/logout',{method:'POST',body:{},cookie:alice});assert.equal((await api('/api/auth/me',{cookie:alice})).status,401);
    assert.equal((await api('/api/auth/me',{cookie:bob})).status,200);
    console.log('PASS real PostgreSQL: account registration/login, two-device media sync, isolated records, conflict detection, logout'+(local?' and server restart persistence':''));
  }finally{
    await stop();
    try{await db.query('DELETE FROM langsidu_users WHERE username=ANY($1::text[])',[names.map(n=>n.toLowerCase())]);console.log('Synthetic test accounts removed; existing accounts untouched');}finally{await db.end();}
  }
})().catch(error=>{console.error('Live account check failed:',error.code||error.name);process.exitCode=1;});
