const crypto = require('node:crypto');
const {promisify} = require('node:util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'langsidu_session';
const SESSION_SECONDS = 30 * 86400;
const passwordOK = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
const fail = (status, message) => Object.assign(new Error(message), {status});
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const defaults = () => ({profile:{nick:'',avatarType:'emoji',avatarValue:'🦊',avatarImage:''},prefs:{purpose:'学习',accent:'美式',education:'大学及以上（仅作一般口语练习）'},theme:'blue',themeCustom:false});

function cleanSettings(value = {}) {
  const result=defaults();
  if (!value || typeof value !== 'object') throw fail(400,'学习偏好格式无效');
  const profile=value.profile||{}, prefs=value.prefs||{};
  result.profile.nick=String(profile.nick||'').trim().slice(0,20);
  result.profile.avatarValue=String(profile.avatarValue||'🦊').slice(0,20);
  if(profile.avatarType==='image'){
    if(typeof profile.avatarImage!=='string'||profile.avatarImage.length>=760000||!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(profile.avatarImage))throw fail(400,'头像须为小于 550 KB 的 JPG、PNG 或 WebP 图片');
    result.profile.avatarType='image';result.profile.avatarImage=profile.avatarImage;
  }
  if(['学习','工作','旅游','仅作日常交流'].includes(prefs.purpose)) result.prefs.purpose=prefs.purpose;
  result.prefs.accent=prefs.accent==='英式'?'英式':'美式';
  if(['小学','初中','高中','四级','六级','专四','专八','大学及以上（仅作一般口语练习）'].includes(prefs.education))result.prefs.education=prefs.education;
  if(['red','orange','yellow','green','cyan','blue'].includes(value.theme))result.theme=value.theme;
  result.themeCustom=value.themeCustom===true;
  return result;
}
function cleanRecords(records) {
  if(!Array.isArray(records)||records.length>1000)throw fail(400,'记录格式无效，最多支持 1000 条记录');
  const ids=new Set();
  return records.map(item=>{
    if(!item||typeof item!=='object'||!Number.isSafeInteger(item.id)||ids.has(item.id))throw fail(400,'练习记录编号无效或重复');
    ids.add(item.id);
    const record={id:item.id};
    for(const key of ['transcript','corrected','rereadTranscript','time','sceneName','sceneCategory','keywords','intent','accent','rereadAccent']){
      if(item[key]!=null && typeof item[key]!=='string')throw fail(400,'练习文字格式无效');
      if((item[key]||'').length>100000)throw fail(400,'单条文稿过长');
      record[key]=item[key]||'';
    }
    for(const key of ['image','audio','rereadAudio']){
      const value=item[key]||'';
      const pattern=key==='image'?/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/:/^data:(?:audio\/(?:webm|ogg|mp4|mpeg|wav)(?:;codecs=[a-zA-Z0-9.,-]+)?|video\/webm);base64,[A-Za-z0-9+/=]+$/;
      if(typeof value!=='string'||(value&&!pattern.test(value)))throw fail(400,'照片或录音格式无效，请使用实际录音或图片');
      record[key]=value;
    }
    for(const key of ['evaluation','polishEvaluation','finalEvaluation']){
      if(item[key]!=null && (typeof item[key]!=='object'||Array.isArray(item[key])||JSON.stringify(item[key]).length>500000))throw fail(400,'评测结果格式无效');
      record[key]=item[key]||null;
    }
    return record;
  });
}
async function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')) {
  const digest=await scrypt(password,salt,64,{N:16384,r:8,p:1});
  return `${salt}:${digest.toString('hex')}`;
}
async function verifyPassword(password,stored) {
  const candidate=await passwordHash(password,stored.split(':')[0]);
  const a=Buffer.from(candidate),b=Buffer.from(stored);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
async function readJSON(req,limit) {
  const chunks=[];let bytes=0,large=false;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){large=true;chunks.length=0;}if(!large)chunks.push(chunk);}
  if(large)throw fail(413,'本次记录与录音超过 64 MB，请减少录音长度或先导出较早的记录');
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw fail(400,'请求数据格式无效');}
}
function createCloudAccounts({db,connectionString=process.env.DATABASE_URL,secureCookie=!!process.env.RENDER,now=()=>Date.now()}={}) {
  const enabled=!!(db||connectionString);
  if(!db&&connectionString){
    const {Pool}=require('pg');
    db=new Pool({connectionString,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
    db.on('error',()=>console.error('Cloud account database connection failed'));
  }
  let readyPromise;
  async function ready(){
    if(!enabled)throw fail(503,'云端账号尚未配置，请联系站主连接数据库');
    if(!readyPromise) readyPromise=(async()=>{
      await db.query(`CREATE TABLE IF NOT EXISTS langsidu_users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, login_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, settings JSONB NOT NULL, records JSONB NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await db.query(`CREATE TABLE IF NOT EXISTS langsidu_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES langsidu_users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL)`);
      await db.query('CREATE INDEX IF NOT EXISTS langsidu_session_expiry ON langsidu_sessions(expires_at)');
      await db.query(`CREATE TABLE IF NOT EXISTS langsidu_auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at BIGINT NOT NULL)`);
    })().catch(error=>{readyPromise=null;throw error;});
    return readyPromise;
  }
  function reply(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
  function cookie(res,token,req){
    const secure=secureCookie||req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?SESSION_SECONDS:0}${secure?'; Secure':''}`);
  }
  function tokenOf(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';}
  async function userOf(req){
    const token=tokenOf(req);if(!/^[a-f0-9]{64}$/.test(token))throw fail(401,'请先登录账号');
    const result=await db.query('SELECT u.id, u.login_name, u.settings, u.revision FROM langsidu_users u JOIN langsidu_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2',[hashToken(token),now()]);
    if(!result.rows.length)throw fail(401,'登录已过期，请重新登录');
    return result.rows[0];
  }
  async function session(req,res,id){
    await db.query('DELETE FROM langsidu_sessions WHERE expires_at <= $1',[now()]);
    const token=crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO langsidu_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,now()+SESSION_SECONDS*1000]);
    cookie(res,token,req);
  }
  async function throttle(req){
    const forwarded=(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
    const address=forwarded.at(-1)||req.socket.remoteAddress||'unknown';
    await db.query('DELETE FROM langsidu_auth_limits WHERE reset_at <= $1',[now()]);
    const result=await db.query(`INSERT INTO langsidu_auth_limits(key,attempts,reset_at) VALUES($1,1,$2)
      ON CONFLICT(key) DO UPDATE SET attempts=langsidu_auth_limits.attempts+1 RETURNING attempts`,[hashToken(address),now()+600000]);
    if(result.rows[0].attempts>30)throw fail(429,'登录或注册尝试过多，请 10 分钟后再试');
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/auth/')&&url.pathname!=='/api/account/settings'&&url.pathname!=='/api/account/history')return false;
    try{
      if(url.pathname==='/api/auth/config'&&req.method==='GET'){reply(res,200,{enabled});return true;}
      if(req.method!=='GET'){
        if(req.headers['x-langsidu-request']!=='account')throw fail(403,'请通过朗思渡网页提交请求');
        const origin=req.headers.origin;
        if(origin&&new URL(origin).host!==req.headers.host)throw fail(403,'请求来源不受支持');
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'请使用 JSON 提交');
      }
      await ready();
      if(['/api/auth/register','/api/auth/login'].includes(url.pathname)&&req.method==='POST'){
        await throttle(req);
        const body=await readJSON(req,1000000);
        const loginName=typeof body.nickname==='string'?body.nickname.normalize('NFKC').trim():'';
        if(!loginName||loginName.length>20||/[\x00-\x1f\x7f]/.test(loginName))throw fail(400,'昵称须为 1–20 个字符');
        if(!passwordOK(body.password))throw fail(400,'密码须为 8–128 位，至少包含英文大写字母、小写字母和数字');
        const username=loginName.toLowerCase();let user;
        if(url.pathname.endsWith('/register')){
          if(body.password!==body.confirmPassword)throw fail(400,'两次输入的密码不一致');
          const settings=cleanSettings(body.settings);settings.profile.nick=loginName;
          try{
            const result=await db.query('INSERT INTO langsidu_users(id,username,login_name,password_hash,settings) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,login_name,settings',[crypto.randomUUID(),username,loginName,await passwordHash(body.password),JSON.stringify(settings)]);
            user=result.rows[0];
          }catch(error){if(error.code==='23505')throw fail(409,'这个昵称已被注册，请换一个昵称或前往登录');throw error;}
        }else{
          const result=await db.query('SELECT id,login_name,settings,password_hash FROM langsidu_users WHERE username=$1',[username]);
          user=result.rows[0];
          const stored=user?.password_hash||'00000000000000000000000000000000:'+ '0'.repeat(128);
          if(!await verifyPassword(body.password,stored)||!user)throw fail(401,'昵称或密码不正确');
        }
        await session(req,res,user.id);
        reply(res,200,{user:{id:user.id,loginName:user.login_name,settings:user.settings}});return true;
      }
      if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
        await db.query('DELETE FROM langsidu_sessions WHERE token_hash=$1',[hashToken(tokenOf(req))]);cookie(res,'',req);reply(res,200,{ok:true});return true;
      }
      const user=await userOf(req);
      if(url.pathname==='/api/auth/me'&&req.method==='GET'){reply(res,200,{user:{id:user.id,loginName:user.login_name,settings:user.settings}});return true;}
      if(url.pathname==='/api/account/settings'&&req.method==='PUT'){
        const settings=cleanSettings(await readJSON(req,1000000));
        await db.query('UPDATE langsidu_users SET settings=$1::jsonb WHERE id=$2',[JSON.stringify(settings),user.id]);reply(res,200,{settings});return true;
      }
      if(url.pathname==='/api/account/history'&&req.method==='GET'){
        const result=await db.query('SELECT records,revision FROM langsidu_users WHERE id=$1',[user.id]);reply(res,200,result.rows[0]);return true;
      }
      if(url.pathname==='/api/account/history'&&req.method==='PUT'){
        const body=await readJSON(req,64*1024*1024);
        if(!Number.isSafeInteger(body.revision)||body.revision<0)throw fail(400,'记录版本无效');
        const records=cleanRecords(body.records);
        const result=await db.query('UPDATE langsidu_users SET records=$1::jsonb, revision=revision+1 WHERE id=$2 AND revision=$3 RETURNING revision',[JSON.stringify(records),user.id,body.revision]);
        if(!result.rows.length)throw fail(409,'另一台设备已更新记录，正在重新同步');
        reply(res,200,{revision:result.rows[0].revision});return true;
      }
      reply(res,404,{error:'账号接口不存在'});
    }catch(error){
      if(!error.status)console.error('Cloud account request failed',error.code||error.name);
      reply(res,error.status||503,{error:error.status?error.message:'云端账号服务暂不可用，请稍后重试。现有云端记录保留。'});
    }
    return true;
  }
  return {enabled,ready,handle,close:()=>db?.end?.()||db?.close?.()};
}
module.exports={createCloudAccounts,passwordOK,cleanRecords,cleanSettings};
