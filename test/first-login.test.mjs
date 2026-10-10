import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture,api,setup,skill} from './helpers.mjs';
import {legacyToken} from './helpers.mjs';
import {handler} from '../src/index.js';
import {INITIAL_ADMIN_PASSWORD,hashInitialPassword,hashPassword,validatePassword,verifyPassword} from '../src/password.js';
import {issueToken} from '../src/auth.js';
import {recoverySql} from '../scripts/reset-password.mjs';
const NEXT='First changed 2026';
async function web(env,route,body,s,method=body===undefined?'GET':'POST',extra={}){
  const res=await handler(new Request('https://hub.example'+route,{method,
    headers:{Origin:'https://hub.example','X-CloudSkill-Request':'1',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(s?{Cookie:s.cookie,'X-CSRF-Token':s.data.csrfToken}:{}),...extra},
    body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function initial(env,extra={}){
  const created=await web(env,'/api/auth/setup',{secret:env.BOOTSTRAP_SECRET,...extra});
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.mustChangePassword,true);
  return web(env,'/api/auth/login',{username:extra.username||'admin',password:extra.password??INITIAL_ADMIN_PASSWORD});
}
const change=(env,s,extra={})=>web(env,'/api/auth/password',{currentPassword:INITIAL_ADMIN_PASSWORD,newPassword:NEXT,...extra},s);

test('default is exactly lanchenglin; only initial setup may use it as a new password',async()=>{
  assert.equal(INITIAL_ADMIN_PASSWORD,'lanchenglin');
  assert.equal(validatePassword(INITIAL_ADMIN_PASSWORD),INITIAL_ADMIN_PASSWORD);
  await assert.rejects(hashPassword(INITIAL_ADMIN_PASSWORD),/initial password/);
  await assert.rejects(hashInitialPassword('short'),/6–20/);
  const a=await hashInitialPassword(),b=await hashInitialPassword();
  assert.notEqual(a,b);assert.ok(!a.includes(INITIAL_ADMIN_PASSWORD));
  assert.ok(await verifyPassword(INITIAL_ADMIN_PASSWORD,a));
  const f=fixture();try{
    const s=await initial(f.env,{mustChangePassword:false,activationSecretRequired:false});
    assert.equal(s.status,200);assert.equal(s.data.mustChangePassword,true);assert.equal(s.data.activationSecretRequired,false);
    const record=f.db.prepare('SELECT * FROM web_admin').get();
    assert.equal(record.username,'admin');assert.equal(record.must_change_password,1);
    assert.equal(record.activation_secret_hash,null);
    const audit=JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all());
    for(const secret of [INITIAL_ADMIN_PASSWORD,f.env.BOOTSTRAP_SECRET,s.cookie])assert.ok(!audit.includes(secret));
    assert.equal(s.data.activation_secret_hash,undefined);
    assert.ok(!JSON.stringify(s.data).includes(f.env.BOOTSTRAP_SECRET));
  }finally{f.close();}
});

test('pending session cannot use any protected API, even by forging flags or bypassing the UI',async()=>{
  const f=fixture();try{
    const s=await initial(f.env);
    for(const [route,method,body] of [
      ['/api/me','GET'],['/api/catalog','GET'],['/api/skills','GET'],['/api/capabilities','GET'],
      ['/api/projects','GET'],['/api/projects','POST',{slug:'personal',title:'Personal'}],
      ['/api/tokens','GET'],['/api/tokens','POST',{label:'Bypass',role:'publisher',projects:['personal'],mustChangePassword:false}],
      ['/api/tokens/t_web_owner/revoke','POST',{}],['/api/uploads','GET'],['/api/uploads/cleanup','POST',{}],
      ['/api/projects/personal/skills/example','POST',{files:skill('example')}],
      ['/api/projects/personal/skills/example/uploads','POST',{}],['/api/projects/personal/skills/example/download','GET'],
      ['/api/projects/personal/skills/example/versions/1/download','GET'],
      ['/api/projects/personal/skills/example/versions/1/file?path=SKILL.md','GET'],
      ['/api/projects/personal/skills/example/rollback','POST',{version:1}],
      ['/api/devices','GET'],['/api/devices/heartbeat','POST',{}],['/api/audit','GET'],
      ['/api/auth/reauth','POST',{password:INITIAL_ADMIN_PASSWORD}],
      ['/api/auth/revoke-all-tokens','POST',{confirm:'revoke-all-api-tokens'}]
    ]){
      const response=await web(f.env,route,body,s,method);
      assert.equal(response.status,403,route+JSON.stringify(response.data));
      assert.equal(response.data.error,'password_change_required',route);
    }
    await assert.rejects(issueToken(f.env,'Bypass','publisher',['personal']),/password_change_required/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  }finally{f.close();}
});

test('first change needs only current/new passwords with a valid session and CSRF, not the bootstrap secret',async()=>{
  const f=fixture();try{
    const s=await initial(f.env);
    // Setup proof can be removed immediately after setup. Password changes never read it.
    delete f.env.BOOTSTRAP_SECRET;
    const body={currentPassword:INITIAL_ADMIN_PASSWORD,newPassword:NEXT};
    assert.equal((await web(f.env,'/api/auth/password',body,undefined)).status,401);
    assert.equal((await web(f.env,'/api/auth/password',body,s,'POST',{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await web(f.env,'/api/auth/password',body,s,'POST',{Origin:'https://other.example'})).status,403);
    assert.equal((await change(f.env,s,{currentPassword:'wrong'})).status,401);
    assert.equal((await change(f.env,s,{newPassword:INITIAL_ADMIN_PASSWORD})).status,400);
    assert.equal(f.db.prepare('SELECT must_change_password FROM web_admin').get().must_change_password,1);
    assert.equal((await change(f.env,s)).status,200);
    const user=f.db.prepare('SELECT * FROM web_admin').get();
    assert.equal(user.must_change_password,0);assert.equal(user.activation_secret_hash,null);
    assert.equal((await web(f.env,'/api/auth/session',undefined,s)).status,401);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD})).status,401);
    const activated=await web(f.env,'/api/auth/login',{username:'admin',password:NEXT});
    assert.equal(activated.data.mustChangePassword,false);assert.equal(activated.data.activationSecretRequired,false);
    assert.equal((await web(f.env,'/api/projects',{slug:'personal',title:'Personal'},activated)).status,201);
    const token=await web(f.env,'/api/tokens',{label:'Personal editing',role:'all_writer'},activated);
    assert.equal(token.status,201);assert.equal((await api(f.env,'/api/me','GET',null,token.data.token)).data.role,'all_writer');
  }finally{f.close();}
});

test('a retained activation hash from an earlier setup cannot force proof after the application update',async()=>{
  const f=fixture();try{
    const first=await initial(f.env);
    f.db.prepare('UPDATE web_admin SET activation_secret_hash=?').run('a'.repeat(64));
    delete f.env.BOOTSTRAP_SECRET;
    const restored=await web(f.env,'/api/auth/session',undefined,first);
    assert.equal(restored.data.mustChangePassword,true);
    assert.equal(restored.data.activationSecretRequired,false);
    const login=await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD});
    assert.equal(login.data.activationSecretRequired,false);
    assert.equal((await web(f.env,'/api/catalog',undefined,login)).data.error,'password_change_required');
    assert.equal((await change(f.env,login)).status,200);
    assert.equal(f.db.prepare('SELECT activation_secret_hash FROM web_admin').get().activation_secret_hash,null);
    assert.equal((await web(f.env,'/api/auth/session',undefined,first)).status,401);
  }finally{f.close();}
});

test('obsolete optional proof values are ignored without bypassing the password or CSRF checks',async()=>{
  const f=fixture();try{
    const s=await initial(f.env);
    f.db.prepare('UPDATE web_admin SET activation_secret_hash=?').run('b'.repeat(64));
    assert.equal((await change(f.env,s,{currentPassword:'wrong',bootstrapSecret:'obsolete-value'})).status,401);
    assert.equal((await change(f.env,s,{bootstrapSecret:'obsolete-value'})).status,200);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:NEXT})).data.mustChangePassword,false);
  }finally{f.close();}
});

test('removing proof from password changes does not remove authorization from account setup',async()=>{
  const f=fixture();try{
    assert.equal((await web(f.env,'/api/auth/setup',{})).status,403);
    assert.equal((await web(f.env,'/api/auth/setup',{secret:'wrong'})).status,403);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get().n,0);
    const s=await initial(f.env);
    assert.equal((await web(f.env,'/api/auth/setup',{secret:f.env.BOOTSTRAP_SECRET})).status,409);
    assert.equal(s.data.mustChangePassword,true);
    assert.equal((await web(f.env,'/api/catalog',undefined,s)).status,403);
  }finally{f.close();}
});

test('refresh, second login and logout cannot clear the persisted requirement; all pending cookies expire after change',async()=>{
  const f=fixture();try{
    const s=await initial(f.env);
    for(let i=0;i<3;i++)assert.equal((await web(f.env,'/api/auth/session',undefined,s)).data.mustChangePassword,true);
    assert.equal((await web(f.env,'/api/auth/logout',{},s)).status,200);
    const second=await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD});
    const third=await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD});
    assert.equal(second.data.mustChangePassword,true);assert.equal(third.data.mustChangePassword,true);
    assert.equal((await change(f.env,second)).status,200);
    assert.equal((await web(f.env,'/api/auth/session',undefined,third)).status,401);
    assert.equal((await change(f.env,third,{newPassword:'Not accepted 12345'})).status,401);
    assert.ok(await verifyPassword(NEXT,f.db.prepare('SELECT password_hash FROM web_admin').get().password_hash));
  }finally{f.close();}
});

test('custom strong setup also requires a different password and cannot clear the flag in the setup payload',async()=>{
  const f=fixture();try{
    const password='Custom initial 12345';
    const s=await initial(f.env,{password,mustChangePassword:false});
    assert.equal(s.data.mustChangePassword,true);assert.equal(s.data.activationSecretRequired,false);
    assert.equal((await change(f.env,s,{currentPassword:password,newPassword:password})).status,400);
    assert.equal((await change(f.env,s,{currentPassword:password})).status,200);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password})).status,401);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:NEXT})).data.mustChangePassword,false);
  }finally{f.close();}
});

test('legacy conversion still requires its admin token at setup, but not again during the first password change',async()=>{
  const f=fixture();try{
    const old=await setup(f.env);
    await api(f.env,'/api/projects','POST',{slug:'personal',title:'Personal'},old);
    const reader=(await legacyToken(f.env,'Existing B','client',['personal'])).token;
    assert.equal((await web(f.env,'/api/auth/setup',{username:'admin',secret:f.env.BOOTSTRAP_SECRET})).status,403);
    const created=await web(f.env,'/api/auth/setup',{username:'admin'},undefined,'POST',{Authorization:'Bearer '+old});
    assert.equal(created.status,201);
    for(const token of [old,reader])assert.equal((await api(f.env,'/api/catalog','GET',null,token)).data.error,'password_change_required');
    const s=await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD});
    assert.equal(s.data.activationSecretRequired,false);
    assert.equal((await change(f.env,s)).status,200);
    for(const token of [old,reader])assert.equal((await api(f.env,'/api/catalog','GET',null,token)).status,200);
  }finally{f.close();}
});

test('trusted D1 recovery clears pending state with a strong password, never resets to the public default',async()=>{
  const f=fixture();try{
    const s=await initial(f.env),hash=await hashPassword(NEXT);
    f.db.exec(recoverySql({hash,version:1}));
    const row=f.db.prepare('SELECT * FROM web_admin').get();assert.equal(row.must_change_password,0);assert.equal(row.activation_secret_hash,null);
    assert.equal((await web(f.env,'/api/auth/session',undefined,s)).status,401);
    const fresh=await web(f.env,'/api/auth/login',{username:'admin',password:NEXT});
    assert.equal(fresh.data.mustChangePassword,false);
    assert.equal((await web(f.env,'/api/catalog',undefined,fresh)).status,200);
  }finally{f.close();}
});

test('new migration does not change existing administrator password or revoke existing sessions',()=>{
  const db=new DatabaseSync(':memory:');try{
    for(const name of ['0001_initial.sql','0002_binary_uploads.sql','0003_web_auth.sql'])
      db.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    db.exec("INSERT INTO access_tokens(id,label,token_hash,role,credential_type,created_at) VALUES('t_web_owner','Owner','existing-token-hash','admin','web','2026-10-09')");
    db.exec("INSERT INTO web_admin(id,username,password_hash,password_version,token_id,created_at,updated_at) VALUES(1,'existing-owner','existing-password-hash',9,'t_web_owner','2026-10-09','2026-10-09')");
    db.exec("INSERT INTO web_sessions VALUES('existing-session',1,9,'existing-csrf',1,9999999999999,9999999999999,1)");
    db.exec(fs.readFileSync(new URL('../migrations/0004_require_password_change.sql',import.meta.url),'utf8'));
    const row=db.prepare('SELECT * FROM web_admin').get();
    assert.equal(row.password_hash,'existing-password-hash');assert.equal(row.password_version,9);assert.equal(row.must_change_password,0);
    assert.equal(row.activation_secret_hash,null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
