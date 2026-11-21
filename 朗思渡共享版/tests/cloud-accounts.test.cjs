const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {fixture,registration,record}=require('./cloud-fixture.cjs');
const {createCloudAccounts}=require('../cloud-accounts');

test('cloud accounts: authentication, isolation, persistence, concurrent updates and expiry',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'langsidu-account-test-'));
  let clock=Date.now(),app;
  try{
    app=await fixture({directory,now:()=>clock});
    const api=(route,options)=>app.request(route,options);
    assert.deepEqual((await api('/api/auth/config')).data,{enabled:true});
    assert.equal((await api('/api/auth/me')).status,401);
    for(const password of ['english123','ENGLISH123','EnglishOnly','Aa1'])assert.equal((await api('/api/auth/register',{method:'POST',body:{...registration(),password,confirmPassword:password}})).status,400);
    assert.equal((await api('/api/auth/register',{method:'POST',body:{...registration(),confirmPassword:'Wrong123'}})).status,400);
    assert.equal((await api('/api/auth/register',{method:'POST',body:null})).status,400);
    assert.equal((await api('/api/auth/register',{method:'POST',body:registration(),headers:{'X-Langsidu-Request':''}})).status,403);
    assert.equal((await api('/api/auth/register',{method:'POST',body:registration(),headers:{Origin:'https://attacker.example'}})).status,403);
    const registered=await api('/api/auth/register',{method:'POST',body:registration()});
    assert.equal(registered.status,200);const aliceCookie=registered.cookie.split(';')[0],aliceID=registered.data.user.id;
    assert.match(registered.cookie,/HttpOnly/);assert.match(registered.cookie,/SameSite=Lax/);assert.doesNotMatch(JSON.stringify(registered.data),/English123|password_hash/);
    assert.equal((await api('/api/auth/register',{method:'POST',body:registration('ＡＬＩＣＥ')})).status,409);
    assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:'Alice',password:'Wrong123'}})).status,401);
    assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:'Nobody',password:'Wrong123'}})).status,401);
    const login=await api('/api/auth/login',{method:'POST',body:{nickname:'alice',password:'English123'}});assert.equal(login.status,200);
    assert.notEqual(login.cookie.split(';')[0],aliceCookie);
    const stored=await app.db.query('SELECT password_hash FROM langsidu_users WHERE id=$1',[aliceID]);
    assert.match(stored.rows[0].password_hash,/^[a-f0-9]{32}:[a-f0-9]{128}$/);assert.doesNotMatch(stored.rows[0].password_hash,/English123/);
    const session=await app.db.query('SELECT token_hash FROM langsidu_sessions');assert.ok(session.rows.every(row=>!aliceCookie.includes(row.token_hash)));
    const bob=await api('/api/auth/register',{method:'POST',body:registration('Bob')});const bobCookie=bob.cookie.split(';')[0];
    const history=await api('/api/account/history',{cookie:aliceCookie});assert.deepEqual(history.data,{records:[],revision:0});
    assert.equal((await api('/api/account/history',{method:'PUT',body:{records:[record()],revision:0},cookie:aliceCookie})).status,200);
    assert.deepEqual((await api('/api/account/history',{cookie:bobCookie})).data.records,[]);
    const fakeID=await api('/api/account/history?userId='+aliceID,{cookie:bobCookie});assert.deepEqual(fakeID.data.records,[]);
    await api('/api/account/history',{method:'PUT',body:{records:[record(2)],revision:0,userId:aliceID},cookie:bobCookie});
    assert.equal((await api('/api/account/history',{cookie:aliceCookie})).data.records[0].id,1);
    assert.equal((await api('/api/account/history',{method:'PUT',body:{records:[],revision:0},cookie:aliceCookie})).status,409);
    assert.equal((await api('/api/account/history',{method:'PUT',body:{records:[{...record(),audio:'https://example.org/audio'}],revision:1},cookie:aliceCookie})).status,400);
    assert.equal((await api('/api/account/history',{method:'PUT',body:{records:[record(),record()],revision:1},cookie:aliceCookie})).status,400);
    assert.equal((await api('/api/account/settings',{method:'PUT',body:{profile:{avatarType:'image',avatarImage:'javascript:alert(1)'}},cookie:aliceCookie})).status,400);
    assert.equal((await api('/api/account/settings',{method:'PUT',body:{prefs:{accent:'美式',purpose:'工作'},profile:{nick:'练习者'}},cookie:aliceCookie})).status,200);
    assert.equal((await api('/api/auth/me',{cookie:bobCookie})).data.user.settings.prefs.accent,'英式');
    const competing=await Promise.all([api('/api/account/history',{method:'PUT',body:{records:[record(3)],revision:1},cookie:aliceCookie}),api('/api/account/history',{method:'PUT',body:{records:[record(4)],revision:1},cookie:aliceCookie})]);
    assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
    const before=await api('/api/account/history',{cookie:aliceCookie});
    await app.close();app=null;
    app=await fixture({directory,now:()=>clock,secureCookie:true});
    assert.deepEqual((await api('/api/account/history',{cookie:aliceCookie})).data,before.data,'database and session survive server restart');
    assert.equal((await api('/api/auth/me',{cookie:aliceCookie})).data.user.settings.prefs.accent,'美式');
    const newLogin=await api('/api/auth/login',{method:'POST',body:{nickname:'Alice',password:'English123'}});assert.match(newLogin.cookie,/; Secure/);
    await api('/api/auth/logout',{method:'POST',body:{},cookie:aliceCookie});assert.equal((await api('/api/auth/me',{cookie:aliceCookie})).status,401);
    assert.equal((await api('/api/auth/me',{cookie:bobCookie})).status,200);
    clock+=31*86400000;assert.equal((await api('/api/auth/me',{cookie:bobCookie})).status,401);
    for(let i=0;i<30;i++)assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:'Nobody',password:'Wrong123'}})).status,401);
    assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:'Alice',password:'English123'}})).status,429);
    clock+=600001;assert.equal((await api('/api/auth/login',{method:'POST',body:{nickname:'Alice',password:'English123'}})).status,200);
  }finally{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('cloud accounts stay disabled when no database is configured',async()=>{
  const app=createCloudAccounts({connectionString:''});assert.equal(app.enabled,false);await assert.rejects(app.ready(),/尚未配置/);
});

test('an open Safari page can save both recordings without changing their bytes',async()=>{
  const app=await fixture();
  try{
    const registered=await app.request('/api/auth/register',{method:'POST',body:registration()});
    const cookie=registered.cookie.split(';')[0];
    const audio='Zmluc3Q=',reread='c2Vjb25k';
    const safariRecord={...record(),audio:'data:audio/mp4; codecs=mp4a.40.2;base64,'+audio,rereadAudio:'data:audio/mp4; codecs="mp4a.40.2";base64,'+reread};
    const saved=await app.request('/api/account/history',{method:'PUT',body:{records:[safariRecord],revision:0},cookie});
    assert.equal(saved.status,200);
    const result=await app.request('/api/account/history',{cookie});
    assert.equal(result.data.records[0].audio,'data:audio/mp4;codecs=mp4a.40.2;base64,'+audio);
    assert.equal(result.data.records[0].rereadAudio,'data:audio/mp4;codecs=mp4a.40.2;base64,'+reread);
    assert.equal(result.data.records[0].image,safariRecord.image);
    const rejected=await app.request('/api/account/history',{method:'PUT',body:{records:[{...safariRecord,audio:'data:audio/mp4; codecs="mp4a.40.2";extra=bad;base64,'+audio}],revision:1},cookie});
    assert.equal(rejected.status,400);
    assert.deepEqual((await app.request('/api/account/history',{cookie})).data,result.data);
  }finally{await app.close();}
});
