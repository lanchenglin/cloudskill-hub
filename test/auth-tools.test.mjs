import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture,api} from './helpers.mjs';
import {handler} from '../src/index.js';
import {initialize} from '../scripts/initialize-hub.mjs';
import {recoverySql} from '../scripts/reset-password.mjs';
import {hashPassword,verifyPassword} from '../src/password.js';

async function initializationFixture(){
  const f=fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-init-tool-'));
  await fs.chmod(dir,0o700);
  await fs.writeFile(path.join(dir,'bootstrap.json'),JSON.stringify({BOOTSTRAP_SECRET:f.env.BOOTSTRAP_SECRET}),{mode:0o600});
  const output=[],options={url:'https://hub.example',dir,report:x=>output.push(x),fetch:(url,init)=>handler(new Request(url,init),f.env)};
  return {f,dir,output,options,close:async()=>{f.close();await fs.rm(dir,{recursive:true,force:true});}};
}

async function completeInitialization(t){
  const pending=await initialize(t.options);
  assert.equal(pending.status,'password_change_required');
  const account=JSON.parse(await fs.readFile(pending.admin,'utf8'));
  assert.equal(account.password,'lanchenglin');
  assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
  assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  assert.equal((await initialize(t.options)).status,'password_change_required');
  let cookie='',csrf='';
  async function call(route,data){
    const res=await t.options.fetch(t.options.url+route,{method:'POST',headers:{Origin:t.options.url,'X-CloudSkill-Request':'1','Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});
    const result=await res.json();assert.equal(res.status,200,JSON.stringify(result));
    if(res.headers.has('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];if(result.csrfToken)csrf=result.csrfToken;return result;
  }
  await call('/api/auth/login',account);
  const password='AI activated private password for tests 12345';
  await call('/api/auth/password',{currentPassword:account.password,newPassword:password});
  await assert.rejects(initialize(t.options),/HTTP 401/);
  const file=path.join(t.dir,'new-password.json');await fs.writeFile(file,JSON.stringify({password}),{mode:0o600});
  return initialize({...t.options,passwordFile:file});
}

test('AI initializer creates one password account + scoped A/B tokens, saves privately and is repeatable',async()=>{
  const t=await initializationFixture();try{
    const result=await completeInitialization(t);
    const owner=JSON.parse(await fs.readFile(result.admin,'utf8'));
    const pub=JSON.parse(await fs.readFile(result.publisher,'utf8')),reader=JSON.parse(await fs.readFile(result.reader,'utf8'));
    assert.equal(owner.username,'admin');assert.ok(owner.password.length>=32);
    assert.equal(pub.role,'publisher');assert.equal(reader.role,'client');assert.deepEqual(pub.projects,['personal']);
    assert.equal((await api(t.f.env,'/api/me','GET',null,pub.token)).data.role,'publisher');
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,2);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
    await initialize(t.options);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get().n,1);
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,2);
    const log=t.output.join('\n');for(const secret of [owner.password,pub.token,reader.token,t.f.env.BOOTSTRAP_SECRET])assert.ok(!log.includes(secret));
    if(process.platform!=='win32')for(const file of [result.admin,result.publisher,result.reader])assert.equal((await fs.stat(file)).mode&0o777,0o600);
    assert.deepEqual(t.f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await t.close();}
});

test('initializer refuses unknown application before sending credentials and does not duplicate lost tokens',async()=>{
  const t=await initializationFixture();try{
    let calls=0;
    await assert.rejects(initialize({...t.options,fetch:async()=>{calls++;return Response.json({app:'untrusted',version:'0.3.0'});}}),/Unexpected deployed/);
    assert.equal(calls,1);
    const result=await completeInitialization(t);
    await fs.unlink(result.publisher);
    await assert.rejects(initialize(t.options),/saved value is missing/);
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,2);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
  }finally{await t.close();}
});

test('trusted recovery SQL invalidates web sessions, supports explicit token revocation and rejects stale writes',async()=>{
  const t=await initializationFixture();try{
    const files=await completeInitialization(t),owner=JSON.parse(await fs.readFile(files.admin,'utf8'));
    const token=JSON.parse(await fs.readFile(files.reader,'utf8')).token;
    const response=await handler(new Request('https://hub.example/api/auth/login',{method:'POST',headers:{Origin:'https://hub.example','X-CloudSkill-Request':'1','Content-Type':'application/json'},body:JSON.stringify(owner)}),t.f.env);
    assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];await response.body.cancel();
    const hash=await hashPassword('Recovered password for local tests 12345');
    const sql=recoverySql({hash,version:2});assert.ok(!sql.includes('Recovered password'));
    t.f.db.exec(sql);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
    assert.equal((await handler(new Request('https://hub.example/api/auth/session',{headers:{Cookie:cookie}}),t.f.env)).status,401);
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,200);
    assert.equal(await verifyPassword('Recovered password for local tests 12345',t.f.db.prepare('SELECT password_hash FROM web_admin').get().password_hash),true);
    const later=await hashPassword('Second recovered password for local tests 67890');
    t.f.db.exec(recoverySql({hash:later,version:2,revokeTokens:true}));
    assert.equal(t.f.db.prepare('SELECT password_version FROM web_admin').get().password_version,3);
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,200);
    t.f.db.exec(recoverySql({hash:later,version:3,username:'renamed-admin',revokeTokens:true}));
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,401);
    assert.equal(t.f.db.prepare('SELECT username FROM web_admin').get().username,'renamed-admin');
  }finally{await t.close();}
});
