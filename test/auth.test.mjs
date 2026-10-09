import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {hashPassword,verifyPassword,validatePassword,validateUsername,INITIAL_ADMIN_PASSWORD} from '../src/password.js';
import {SESSION_IDLE,SESSION_TTL,REAUTH_TTL,cleanupAuth} from '../src/auth.js';
import {tokenHash} from '../src/core.js';
import {pack} from '../public/lib/archive.js';
const PASSWORD='A long private passphrase for tests 123';
const NEXT_PASSWORD='A different private passphrase for tests 456';
async function web(env,path,method='GET',body,session,headers={}){
  const request=new Request('https://hub.example'+path,{method,headers:{
    'X-CloudSkill-Request':'1',Origin:'https://hub.example',
    ...(body!==undefined?{'Content-Type':'application/json'}:{}),
    ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.data.csrfToken}:{}),...headers,
  },body:body===undefined?undefined:JSON.stringify(body)});
  const response=await handler(request,env);
  const data=await response.json();
  return {response,data,status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function fresh(env){
  const created=await web(env,'/api/auth/setup','POST',{secret:env.BOOTSTRAP_SECRET,username:'owner'});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const initial=await web(env,'/api/auth/login','POST',{username:'owner',password:INITIAL_ADMIN_PASSWORD});
  assert.equal(initial.data.mustChangePassword,true);
  const changed=await web(env,'/api/auth/password','POST',{currentPassword:INITIAL_ADMIN_PASSWORD,newPassword:PASSWORD},initial);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  const session=await web(env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});
  assert.equal(session.status,200,JSON.stringify(session.data));assert.equal(session.data.mustChangePassword,false);return session;
}
async function project(env,session,name='personal'){
  const result=await web(env,'/api/projects','POST',{slug:name,title:name},session);assert.equal(result.status,201);return result;
}
async function issue(env,session,role='client',projects=['personal'],extra={}){
  const r=await web(env,'/api/tokens','POST',{role,projects,label:role+'-test',...extra},session);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}

test('passwords use random salts, a fixed memory-hard profile, Unicode and no truncation',async()=>{
  assert.equal(validateUsername(' My.Admin '),'my.admin');assert.throws(()=>validateUsername('x'));
  assert.throws(()=>validatePassword('12345678'));assert.throws(()=>validatePassword('x'.repeat(129)));
  const value='中文口令 用足够长的句子也可以 🔑🔑🔑';validatePassword(value);
  const a=await hashPassword(value),b=await hashPassword(value);
  assert.match(a,/^scrypt\$16384\$8\$5\$/);assert.notEqual(a,b);assert.ok(!a.includes(value));
  assert.equal(await verifyPassword(value,a),true);assert.equal(await verifyPassword(value+' ',a),false);
  assert.equal(await verifyPassword('wrong',a),false);
  await assert.rejects(verifyPassword(value,'scrypt$1$1$1$unsafe'),/Unsupported/);
});

test('fresh setup activates only after changing the initial password; no reusable admin API token',async()=>{
  const f=fixture();try{
    assert.equal((await web(f.env,'/api/auth/status')).data.initialized,false);
    assert.equal((await web(f.env,'/api/auth/setup','POST',{secret:'wrong',username:'owner',password:PASSWORD})).status,403);
    assert.equal((await web(f.env,'/api/auth/setup','POST',{secret:f.env.BOOTSTRAP_SECRET,username:'owner',password:'weak'})).status,400);
    const login=await fresh(f.env);
    const cookie=login.response.headers.get('set-cookie');
    for(const flag of ['__Host-csh_session=','HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));
    assert.ok(!cookie.includes('Domain='));assert.equal(login.data.token,undefined);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
    assert.ok(!f.db.prepare('SELECT password_hash FROM web_admin').get().password_hash.includes(PASSWORD));
    assert.equal((await web(f.env,'/api/auth/status')).data.initialized,true);
    assert.equal((await web(f.env,'/api/auth/setup','POST',{secret:f.env.BOOTSTRAP_SECRET,username:'second',password:PASSWORD})).status,409);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,login)).data.username,'owner');
    assert.equal((await api(f.env,'/api/catalog')).status,401);
    const internal=f.db.prepare("SELECT * FROM access_tokens WHERE credential_type='web'").get();
    assert.equal(internal.id,'t_web_owner');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('login rejects foreign origins, missing custom header and invalid credentials uniformly',async()=>{
  const f=fixture();try{
    await fresh(f.env);
    const body={username:'owner',password:PASSWORD};
    assert.equal((await web(f.env,'/api/auth/login','POST',body,null,{Origin:'https://evil.example'})).status,403);
    assert.equal((await web(f.env,'/api/auth/login','POST',body,null,{'X-CloudSkill-Request':''})).status,403);
    assert.equal((await web(f.env,'/api/auth/login','POST',body,null,{'Sec-Fetch-Site':'cross-site'})).status,403);
    const badPass=await web(f.env,'/api/auth/login','POST',{...body,password:'wrong'});
    const badUser=await web(f.env,'/api/auth/login','POST',{...body,username:'not-owner'});
    assert.equal(badUser.status,401);assert.deepEqual(badPass.data,badUser.data);
    const audit=JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all());assert.ok(!audit.includes(PASSWORD));assert.ok(!audit.includes('not-owner'));
  }finally{f.close();}
});

test('cookie writes require CSRF; bearer authentication does not fall back to cookies',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);const body={slug:'personal',title:'Personal'};
    assert.equal((await web(f.env,'/api/projects','POST',body,s,{'X-CSRF-Token':''})).status,403);
    assert.equal((await web(f.env,'/api/projects','POST',body,s,{Origin:'null'})).status,403);
    assert.equal((await web(f.env,'/api/projects','POST',body,s,{'X-CSRF-Token':'wrong'})).status,403);
    await project(f.env,s);const t=await issue(f.env,s);
    assert.equal((await api(f.env,'/api/catalog','GET',null,t.token)).status,200);
    assert.equal((await web(f.env,'/api/projects','GET',undefined,s,{Authorization:'Bearer invalid'})).status,401);
    assert.equal((await web(f.env,'/api/projects','POST',{slug:'denied',title:'Denied'},s,{Authorization:'Bearer '+t.token})).status,403);
  }finally{f.close();}
});

test('session rotation, logout, absolute timeout and idle timeout are enforced server-side',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);
    const other=await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});assert.notEqual(s.cookie,other.cookie);
    const out=await web(f.env,'/api/auth/logout','POST',{},s);assert.equal(out.status,200);assert.match(out.response.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,s)).status,401);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,other)).status,200);
    f.db.prepare('UPDATE web_sessions SET last_seen_at=?').run(Date.now()-SESSION_IDLE-1);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,other)).status,401);
    const next=await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});
    f.db.prepare('UPDATE web_sessions SET expires_at=0').run();
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,next)).status,401);
    await cleanupAuth(f.env);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
    assert.equal(SESSION_TTL,12*3600000);
  }finally{f.close();}
});

test('changing a password invalidates all web sessions but leaves API tokens independent',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);await project(f.env,s);const t=await issue(f.env,s,'publisher');
    const second=await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});
    assert.equal((await web(f.env,'/api/auth/password','POST',{currentPassword:'wrong',newPassword:NEXT_PASSWORD},s)).status,401);
    const changed=await web(f.env,'/api/auth/password','POST',{currentPassword:PASSWORD,newPassword:NEXT_PASSWORD},s);
    assert.equal(changed.status,200);assert.equal(changed.data.apiTokensRevoked,false);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,s)).status,401);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,second)).status,401);
    assert.equal((await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD})).status,401);
    assert.equal((await web(f.env,'/api/auth/login','POST',{username:'owner',password:NEXT_PASSWORD})).status,200);
    assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,200);
    assert.equal(f.db.prepare('SELECT password_version FROM web_admin').get().password_version,3);
  }finally{f.close();}
});

test('sensitive token operations require recent password verification and explicit all-token revocation',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);await project(f.env,s);const t=await issue(f.env,s);
    f.db.prepare('UPDATE web_sessions SET reauthenticated_at=?').run(Date.now()-REAUTH_TTL-1);
    const body={label:'new',role:'publisher',projects:['personal']};
    assert.equal((await web(f.env,'/api/tokens','POST',body,s)).data.error,'reauth_required');
    assert.equal((await web(f.env,'/api/auth/reauth','POST',{password:'wrong'},s)).status,401);
    assert.equal((await web(f.env,'/api/auth/reauth','POST',{password:PASSWORD},s)).status,200);
    assert.equal((await web(f.env,'/api/tokens','POST',body,s)).status,201);
    assert.equal((await web(f.env,'/api/auth/revoke-all-tokens','POST',{},s)).status,400);
    const revoked=await web(f.env,'/api/auth/revoke-all-tokens','POST',{confirm:'revoke-all-api-tokens'},s);assert.equal(revoked.status,200);assert.equal(revoked.data.count,2);
    assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,401);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,s)).status,200);
  }finally{f.close();}
});

test('new tokens are scoped, expiring publisher/client only; no internal web identity in token listings',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);await project(f.env,s);
    for(const body of [{role:'admin',projects:[]},{role:'publisher',projects:[]},{role:'publisher',projects:['missing']},
      {role:'client',projects:['personal'],expiresInDays:0},{role:'client',projects:['personal'],expiresInDays:366}])
      assert.equal((await web(f.env,'/api/tokens','POST',{label:'bad',...body},s)).status,400);
    const t=await issue(f.env,s,'publisher');assert.equal(t.role,'publisher');assert.ok(Date.parse(t.expiresAt)>Date.now()+89*86400000);
    const me=await api(f.env,'/api/me','GET',null,t.token);assert.equal(me.data.role,'publisher');assert.deepEqual(me.data.projects,['personal']);
    const list=await web(f.env,'/api/tokens','GET',undefined,s);assert.equal(list.data.tokens.length,1);assert.equal(list.data.tokens[0].role,'publisher');assert.equal(list.data.tokens[0].token,undefined);
    assert.equal(f.db.prepare('SELECT token_hash FROM access_tokens WHERE id=?').get(t.id).token_hash,await tokenHash(t.token));
    f.db.prepare("UPDATE access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(t.id);
    assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,401);
  }finally{f.close();}
});

test('project publisher can publish private JSON/ZIP and cannot cross scopes, expose skills or administer',async()=>{
  const f=fixture();try{
    const s=await fresh(f.env);await project(f.env,s);await project(f.env,s,'other');
    const p=await issue(f.env,s,'publisher'),b=await issue(f.env,s,'client');
    const payload={files:skill('a-skill'),visibility:'private'};
    assert.equal((await api(f.env,'/api/projects/personal/skills/a-skill','POST',payload,p.token)).status,201);
    assert.equal((await api(f.env,'/api/projects/other/skills/a-skill','POST',payload,p.token)).status,403);
    assert.equal((await api(f.env,'/api/projects/personal/skills/a-skill','POST',{...payload,visibility:'public'},p.token)).status,403);
    assert.equal((await api(f.env,'/api/projects/personal/skills/a-skill','POST',payload,b.token)).status,403);
    for(const [url,method,body] of [['/api/projects','POST',{slug:'no',title:'No'}],['/api/tokens','GET'],['/api/tokens','POST',{label:'bad',role:'client',projects:['personal']}],['/api/audit','GET'],['/api/devices','GET'],['/api/uploads/cleanup','POST',{}]])
      assert.equal((await api(f.env,url,method,body,p.token)).status,403,url);
    const pkg=await pack([{name:'SKILL.md',blob:new Blob(['---\nname: zip-publisher\ndescription: Scoped publisher test.\n---\nSafe.'])}]);
    const base='/api/projects/personal/skills/zip-publisher/uploads';
    assert.equal((await api(f.env,base,'POST',{...pkg.manifest,visibility:'public'},p.token)).status,403);
    const begun=await api(f.env,base,'POST',{...pkg.manifest,visibility:'private'},p.token);assert.equal(begun.status,201,JSON.stringify(begun.data));
    const id=begun.data.id;
    const sent=await handler(new Request('https://hub.example/api/uploads/'+id+'/archive',{method:'PUT',headers:{Authorization:'Bearer '+p.token,'Content-Type':'application/zip'},body:pkg.blob}),f.env);assert.equal(sent.status,200,await sent.text());
    assert.equal((await api(f.env,'/api/uploads/'+id+'/finalize','POST',{},p.token)).status,200);
    assert.equal((await api(f.env,'/api/catalog','GET',null,b.token)).data.skills.length,2);
    assert.deepEqual((await api(f.env,'/.well-known/skills/index.json')).data.skills,[]);
    assert.equal((await api(f.env,'/api/uploads/'+id,'GET',null,b.token)).status,403);
    await web(f.env,'/api/tokens/'+p.id+'/revoke','POST',{},s);
    assert.equal((await api(f.env,'/api/catalog','GET',null,p.token)).status,401);
  }finally{f.close();}
});

test('existing API-admin conversion preserves data and requires the original administrator token',async()=>{
  const f=fixture();try{
    const old=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'personal',title:'Personal'},old);
    await api(f.env,'/api/projects/personal/skills/retained','POST',{files:skill('retained')},old);
    const b=(await api(f.env,'/api/tokens','POST',{role:'client',label:'Reader',projects:['personal']},old)).data;
    const status=await web(f.env,'/api/auth/status');assert.equal(status.data.legacyConversion,true);
    const body={secret:f.env.BOOTSTRAP_SECRET,username:'owner',password:PASSWORD};
    assert.equal((await web(f.env,'/api/auth/setup','POST',body)).status,403);
    assert.equal((await web(f.env,'/api/auth/setup','POST',body,null,{Authorization:'Bearer '+b.token})).status,403);
    assert.equal((await web(f.env,'/api/auth/setup','POST',body,null,{Authorization:'Bearer '+old})).status,201);
    const pending=await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});
    assert.equal((await api(f.env,'/api/catalog','GET',null,b.token)).status,403);
    assert.equal((await web(f.env,'/api/auth/password','POST',{currentPassword:PASSWORD,newPassword:NEXT_PASSWORD},pending)).status,200);
    const s=await web(f.env,'/api/auth/login','POST',{username:'owner',password:NEXT_PASSWORD});
    assert.equal((await api(f.env,'/api/catalog','GET',null,b.token)).data.skills[0].slug,'retained');
    assert.equal((await api(f.env,'/api/me','GET',null,old)).status,200);
    const oldId=f.db.prepare('SELECT id FROM access_tokens WHERE token_hash=?').get(await tokenHash(old)).id;
    assert.equal((await web(f.env,'/api/tokens/'+oldId+'/revoke','POST',{},s)).status,200);
    assert.equal((await api(f.env,'/api/me','GET',null,old)).status,401);
    assert.equal((await web(f.env,'/api/auth/session','GET',undefined,s)).status,200);
  }finally{f.close();}
});

test('D1 login limiting stops repeated attempts, returns Retry-After and does not trust X-Forwarded-For',async()=>{
  const f=fixture();try{
    await fresh(f.env);
    for(let i=0;i<8;i++)assert.equal((await web(f.env,'/api/auth/login','POST',{username:'owner',password:'wrong'},null,{'X-Forwarded-For':String(i)})).status,401);
    const blocked=await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD});
    assert.equal(blocked.status,429);assert.ok(Number(blocked.response.headers.get('retry-after'))>0);
    f.db.prepare('UPDATE auth_rate_limits SET reset_at=0').run();await cleanupAuth(f.env);
    assert.equal((await web(f.env,'/api/auth/login','POST',{username:'owner',password:PASSWORD})).status,200);
  }finally{f.close();}
});
