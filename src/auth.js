/** Single-admin browser sessions and independently scoped API credentials. */
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {tokenHash,randomId,slug,now} from './core.js';
import {hashPassword,verifyPassword,validatePassword,validateUsername} from './password.js';
import {problem} from '../public/lib/policy.js';
const one=(db,sql,...a)=>db.prepare(sql).bind(...a).first();
const run=(db,sql,...a)=>db.prepare(sql).bind(...a).run();
const HOURS=3600000;
export const SESSION_TTL=12*HOURS, SESSION_IDLE=30*60000, REAUTH_TTL=5*60000;
const secret=()=>randomBytes(32).toString('hex');
export const allowed=(u,p)=>u.role==='admin'||u.projects.includes(p);
export function admin(u){if(u.role!=='admin')throw problem('Administrator access required',403);}
export function access(u,p){if(!allowed(u,p))throw problem('Project access denied',403);}
export function publisher(u,p){
  if(!['admin','publisher'].includes(u.role))throw problem('Publishing permission required',403);
  if(p!==undefined)access(u,p);
}
export function publishVisibility(u,p,visibility,currentVisibility){
  publisher(u,p);
  // A token entrusted to an AI must not accidentally expose private credentials.
  if(u.role==='publisher'&&(visibility==='public'||currentVisibility==='public'))
    throw problem('Publisher tokens can only publish private skills; public visibility requires the web administrator',403);
}
export function recent(u){
  admin(u);
  if(u.authType==='session'&&u.reauthenticatedAt<Date.now()-REAUTH_TTL)
    throw problem('reauth_required',403);
}
function transport(request){
  const u=new URL(request.url);
  const local=u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!local)throw problem('Authentication requires HTTPS',400);
  return local;
}
export function sameOrigin(request){
  transport(request);
  const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
  if((origin!==null&&origin!==new URL(request.url).origin)||site==='cross-site')
    throw problem('Cross-origin authentication request denied',403);
  // Required for both browser and non-browser clients. Cross-site browsers need a denied CORS preflight.
  if(request.headers.get('x-cloudskill-request')!=='1')throw problem('X-CloudSkill-Request header required',403);
}
function cookieName(request){return transport(request)?'csh_dev_session':'__Host-csh_session';}
function sessionCookie(request,value,seconds){
  const local=transport(request);
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${local?'':'; Secure'}`;
}
function cookieValue(request){
  const name=cookieName(request)+'=',parts=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name));
  if(parts.length!==1)return null;
  const value=parts[0].slice(name.length);return /^[a-f0-9]{64}$/.test(value)?value:null;
}
function equal(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
function csrf(request,u){
  sameOrigin(request);
  if(!equal(request.headers.get('x-csrf-token'),u.csrfToken))throw problem('Invalid CSRF token',403);
}
async function log(env,actor,action,detail={}){
  await run(env.DB,'INSERT INTO audit_log (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)',randomId('a_'),actor,action,JSON.stringify(detail),now());
}
export async function webSession(request,env,{mutating=true}={}){
  const value=cookieValue(request);if(!value)throw problem('Sign in required',401);
  const hash=await tokenHash(value),time=Date.now();
  const row=await one(env.DB,`SELECT s.*,a.username,a.token_id FROM web_sessions s JOIN web_admin a ON a.id=s.admin_id
    JOIN access_tokens t ON t.id=a.token_id WHERE s.session_hash=? AND s.password_version=a.password_version
    AND s.expires_at>? AND s.last_seen_at>? AND t.credential_type='web' AND t.revoked_at IS NULL`,hash,time,time-SESSION_IDLE);
  if(!row)throw problem('Session expired or revoked; sign in again',401);
  const u={id:row.token_id,label:row.username,role:'admin',projects:[],authType:'session',sessionHash:hash,
    csrfToken:row.csrf_token,reauthenticatedAt:row.reauthenticated_at,expiresAt:row.expires_at,passwordVersion:row.password_version};
  if(mutating&&!['GET','HEAD','OPTIONS'].includes(request.method.toUpperCase()))csrf(request,u);
  if(row.last_seen_at<time-60000)await run(env.DB,'UPDATE web_sessions SET last_seen_at=? WHERE session_hash=?',time,hash);
  return u;
}
export async function principal(request,env){
  transport(request);
  // Never turn a bad/expired Bearer into a valid browser session (confused-deputy protection).
  if(request.headers.has('authorization')){
    const h=request.headers.get('authorization');
    if(!/^Bearer csh_[a-f0-9]{48}$/.test(h))throw problem('Authentication required',401);
    const row=await one(env.DB,`SELECT id,label,role,project_scope,can_publish,expires_at,last_used_at FROM access_tokens
      WHERE token_hash=? AND credential_type='api' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,await tokenHash(h.slice(7)),now());
    if(!row)throw problem('Invalid, expired or revoked token',401);
    let projects;try{projects=JSON.parse(row.project_scope);}catch{throw problem('Invalid permission scope',503);}
    if(!Array.isArray(projects)||projects.some(p=>typeof p!=='string'))throw problem('Invalid permission scope',503);
    if(!row.last_used_at||Date.parse(row.last_used_at)<Date.now()-600000)
      await run(env.DB,'UPDATE access_tokens SET last_used_at=? WHERE id=?',now(),row.id);
    return {id:row.id,label:row.label,role:row.role==='admin'?'admin':row.can_publish?'publisher':'client',projects,authType:'token',expiresAt:row.expires_at};
  }
  return webSession(request,env);
}
/** Counters are shared in D1 (not a per-isolate in-memory login lock). */
async function throttle(request,env,action,perIp=10,global=50){
  const time=Date.now(),period=10*60000;
  const ip=request.headers.get('cf-connecting-ip')||'local-or-unknown';
  const keys=[['global',global],[await tokenHash(ip),perIp]];
  for(const [suffix,limit] of keys){
    const row=await one(env.DB,`INSERT INTO auth_rate_limits (key,attempts,reset_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE MIN(attempts+1,1000000) END,
      reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING attempts,reset_at`,
      action+':'+suffix,time+period,time,time,time+period);
    if(row.attempts>limit){const e=problem('Too many authentication attempts; try again later',429);e.retryAfter=Math.max(1,Math.ceil((row.reset_at-time)/1000));throw e;}
  }
}
export async function issueToken(env,label,role,projects,days=90){
  if(typeof label!=='string'||!label.trim()||label.length>80)throw problem('Token label required');
  if(!['client','publisher'].includes(role))throw problem('New API tokens must be client or publisher; use the website for administration');
  if(!Array.isArray(projects)||!projects.length||projects.length>50)throw problem('Choose 1–50 projects');
  projects=[...new Set(projects.map(slug))];
  if(!Number.isInteger(days)||days<1||days>365)throw problem('Token lifetime must be 1–365 days');
  for(const p of projects)if(!await one(env.DB,'SELECT slug FROM projects WHERE slug=?',p))throw problem('Unknown project '+p);
  const token=randomId('csh_'),id=randomId('t_'),expiresAt=new Date(Date.now()+days*24*HOURS).toISOString();
  await run(env.DB,`INSERT INTO access_tokens (id,label,token_hash,role,project_scope,created_at,can_publish,credential_type,expires_at)
    VALUES (?,?,?,'client',?,?,?,'api',?)`,id,label.trim(),await tokenHash(token),JSON.stringify(projects),now(),role==='publisher'?1:0,expiresAt);
  return {id,token,role,projects,expiresAt};
}
async function createAccount(request,env,body){
  if(await one(env.DB,'SELECT id FROM web_admin WHERE id=1'))throw problem('Administrator is already initialized',409);
  const legacy=await one(env.DB,"SELECT id FROM access_tokens WHERE role='admin' AND credential_type='api' LIMIT 1");
  if(legacy){
    // A retained bootstrap secret must not take over an already-initialized token-based instance.
    if(!request.headers.has('authorization'))throw problem('Existing administrator token required for one-time account conversion',403);
    const u=await principal(request,env);admin(u);
  }else{
    if(!env.BOOTSTRAP_SECRET||env.BOOTSTRAP_SECRET.length<24)throw problem('BOOTSTRAP_SECRET must be configured for first initialization',503);
    if(typeof body.secret!=='string'||!equal(await tokenHash(body.secret),await tokenHash(env.BOOTSTRAP_SECRET)))throw problem('Invalid bootstrap secret',403);
  }
  const username=validateUsername(body.username),hashed=await hashPassword(body.password),date=now();
  // The fixed account PK and transaction permit exactly one winner under simultaneous setup.
  try{await env.DB.batch([
    env.DB.prepare(`INSERT INTO access_tokens (id,label,token_hash,role,project_scope,created_at,credential_type)
      VALUES ('t_web_owner',?,?,'admin','[]',?,'web')`).bind(username,await tokenHash(secret()),date),
    env.DB.prepare(`INSERT INTO web_admin (id,username,password_hash,token_id,created_at,updated_at)
      VALUES (1,?,?,'t_web_owner',?,?)`).bind(username,hashed,date,date),
    env.DB.prepare('INSERT INTO audit_log (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(randomId('a_'),username,'web_admin_created','{}',date),
  ]);}catch(e){if(String(e.message).includes('UNIQUE'))throw problem('Administrator is already initialized',409);throw e;}
  return {initialized:true,username};
}
async function createSession(request,env,user){
  const raw=secret(),hash=await tokenHash(raw),csrfToken=secret(),time=Date.now();
  const inserted=await run(env.DB,`INSERT INTO web_sessions (session_hash,admin_id,password_version,csrf_token,created_at,expires_at,last_seen_at,reauthenticated_at)
    SELECT ?,id,password_version,?,?,?,?,? FROM web_admin WHERE id=1 AND password_version=? AND password_hash=?`,
    hash,csrfToken,time,time+SESSION_TTL,time,time,user.password_version,user.password_hash);
  if(!inserted.meta.changes)throw problem('Account changed; sign in again',401);
  const previous=cookieValue(request);
  if(previous)await run(env.DB,'DELETE FROM web_sessions WHERE session_hash=?',await tokenHash(previous));
  // Bound retained sessions. Login rotates the cookie and never exposes its value in JSON.
  await run(env.DB,`DELETE FROM web_sessions WHERE session_hash NOT IN
    (SELECT session_hash FROM web_sessions ORDER BY created_at DESC,rowid DESC LIMIT 10)`);
  return {cookie:sessionCookie(request,raw,SESSION_TTL/1000),body:{username:user.username,role:'admin',csrfToken,expiresAt:time+SESSION_TTL}};
}
export async function authRoutes(request,env,readJson,json){
  const path=new URL(request.url).pathname,method=request.method.toUpperCase();
  if(path==='/api/bootstrap')throw problem('Use /api/auth/setup with username and password; token-only bootstrap is disabled',410);
  if(!path.startsWith('/api/auth/'))return null;
  transport(request);
  if(method==='GET'&&path==='/api/auth/status'){
    const user=await one(env.DB,'SELECT id FROM web_admin WHERE id=1');
    const legacy=await one(env.DB,"SELECT id FROM access_tokens WHERE role='admin' AND credential_type='api' LIMIT 1");
    return json({initialized:Boolean(user),legacyConversion:!user&&Boolean(legacy),setupEnabled:!user&&(Boolean(legacy)||Boolean(env.BOOTSTRAP_SECRET?.length>=24))});
  }
  if(method==='GET'&&path==='/api/auth/session'){
    const u=await webSession(request,env);return json({username:u.label,role:'admin',csrfToken:u.csrfToken,expiresAt:u.expiresAt});
  }
  if(method!=='POST')throw problem('Not found',404);
  sameOrigin(request);
  if(path==='/api/auth/setup'){
    await throttle(request,env,'setup',5,20);
    return json(await createAccount(request,env,await readJson(request,8192)),201);
  }
  if(path==='/api/auth/login'){
    await throttle(request,env,'login');
    const b=await readJson(request,8192),user=await one(env.DB,'SELECT * FROM web_admin WHERE id=1');
    if(!user)throw problem('Complete administrator setup first',409);
    // Always check the same password hash for unknown usernames; no account-name timing oracle.
    const valid=await verifyPassword(b.password,user.password_hash);
    if(!valid||typeof b.username!=='string'||b.username.trim().toLowerCase()!==user.username){
      await log(env,'anonymous','login_failed');throw problem('Invalid username or password',401);
    }
    const login=await createSession(request,env,user);await log(env,user.username,'login');
    const res=json(login.body);res.headers.set('Set-Cookie',login.cookie);return res;
  }
  if(path==='/api/auth/logout'){
    // Expired cookies may still be cleared, but a live session requires its CSRF token.
    let u;try{u=await webSession(request,env,{mutating:false});}catch(e){if(e.status!==401)throw e;}
    if(u){csrf(request,u);await run(env.DB,'DELETE FROM web_sessions WHERE session_hash=?',u.sessionHash);}
    const res=json({ok:true});res.headers.set('Set-Cookie',sessionCookie(request,'',0));return res;
  }
  const u=await webSession(request,env);
  if(path==='/api/auth/reauth'){
    await throttle(request,env,'reauth',5,20);const b=await readJson(request,8192);
    const user=await one(env.DB,'SELECT * FROM web_admin WHERE id=1');
    if(!await verifyPassword(b.password,user.password_hash))throw problem('Current password is incorrect',401);
    const result=await run(env.DB,'UPDATE web_sessions SET reauthenticated_at=? WHERE session_hash=? AND password_version=?',Date.now(),u.sessionHash,user.password_version);
    if(!result.meta.changes)throw problem('Session expired; sign in again',401);
    return json({ok:true});
  }
  if(path==='/api/auth/password'){
    await throttle(request,env,'password',5,20);const b=await readJson(request,8192);
    validatePassword(b.newPassword);
    const user=await one(env.DB,'SELECT * FROM web_admin WHERE id=1');
    if(!await verifyPassword(b.currentPassword,user.password_hash))throw problem('Current password is incorrect',401);
    if(b.currentPassword===b.newPassword)throw problem('Choose a different new password');
    const hash=await hashPassword(b.newPassword);
    const changed=await run(env.DB,`UPDATE web_admin SET password_hash=?,password_version=password_version+1,updated_at=?
      WHERE id=1 AND password_hash=? AND password_version=?`,hash,now(),user.password_hash,u.passwordVersion);
    if(!changed.meta.changes)throw problem('Account changed concurrently; sign in again',409);
    // The database trigger invalidates ALL web sessions. API tokens are intentionally independent.
    await log(env,user.username,'password_changed');
    const res=json({ok:true,sessionsRevoked:true,apiTokensRevoked:false});res.headers.set('Set-Cookie',sessionCookie(request,'',0));return res;
  }
  if(path==='/api/auth/revoke-all-tokens'){
    recent(u);const b=await readJson(request,1024);
    if(b.confirm!=='revoke-all-api-tokens')throw problem('Explicit confirmation is required');
    const result=await run(env.DB,"UPDATE access_tokens SET revoked_at=? WHERE credential_type='api' AND revoked_at IS NULL",now());
    await log(env,u.label,'revoke_all_api_tokens',{count:result.meta.changes});return json({ok:true,count:result.meta.changes});
  }
  throw problem('Not found',404);
}
export async function cleanupAuth(env,time=Date.now()){
  await env.DB.batch([
    env.DB.prepare('DELETE FROM web_sessions WHERE session_hash IN (SELECT session_hash FROM web_sessions WHERE expires_at<=? OR last_seen_at<=? LIMIT 100)').bind(time,time-SESSION_IDLE),
    env.DB.prepare('DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE reset_at<=? LIMIT 500)').bind(time),
  ]);
}
