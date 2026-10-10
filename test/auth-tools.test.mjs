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
  const f=fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-init-tool-'));await fs.chmod(dir,0o700);
  await fs.writeFile(path.join(dir,'bootstrap.json'),JSON.stringify({BOOTSTRAP_SECRET:f.env.BOOTSTRAP_SECRET}),{mode:0o600});
  const output=[],options={url:'https://hub.example',dir,report:x=>output.push(x),fetch:(url,init)=>handler(new Request(url,init),f.env)};
  return {f,dir,output,options,close:async()=>{f.close();await fs.rm(dir,{recursive:true,force:true});}};
}
async function web(t){
  let cookie='',csrf='';
  return async(route,data)=>{
    const res=await t.options.fetch(t.options.url+route,{method:data===undefined?'GET':'POST',headers:{Origin:t.options.url,'X-CloudSkill-Request':'1','Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await res.json();assert.equal(res.status,route==='/api/tokens'?201:200,JSON.stringify(result));
    if(res.headers.has('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];if(result.csrfToken)csrf=result.csrfToken;return result;
  };
}
async function completeInitialization(t){
  const pending=await initialize(t.options);assert.equal(pending.status,'password_change_required');
  const account=JSON.parse(await fs.readFile(pending.admin,'utf8'));assert.equal(account.password,'lanchenglin');
  assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
  assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  assert.equal((await initialize(t.options)).status,'password_change_required');
  const call=await web(t);await call('/api/auth/login',account);
  const password='AI activated 12345';
  await call('/api/auth/password',{currentPassword:account.password,newPassword:password});
  await assert.rejects(initialize(t.options),/HTTP 401/);
  const file=path.join(t.dir,'new-password.json');await fs.writeFile(file,JSON.stringify({password}),{mode:0o600});
  return initialize({...t.options,passwordFile:file});
}

test('AI initializer creates/activates one website account and never issues or assigns device tokens',async()=>{
  const t=await initializationFixture();try{
    const result=await completeInitialization(t),owner=JSON.parse(await fs.readFile(result.admin,'utf8'));
    assert.equal(owner.username,'admin');assert.equal(owner.password,'AI activated 12345');assert.equal(result.status,'ready');
    assert.equal(result.publisher,undefined);assert.equal(result.reader,undefined);
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
    await initialize(t.options);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get().n,1);
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
    for(const file of ['publisher-a.json','client-b.json'])await assert.rejects(fs.access(path.join(t.dir,file)),{code:'ENOENT'});
    const log=t.output.join('\n');for(const value of [owner.password,t.f.env.BOOTSTRAP_SECRET])assert.ok(!log.includes(value));
    assert.match(log,/Issue shared-writer or all-writer tokens yourself/);
    if(process.platform!=='win32')assert.equal((await fs.stat(result.admin)).mode&0o777,0o600);
    assert.deepEqual(t.f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await t.close();}
});

test('initializer rejects unknown application before secrets and cannot reset an existing account when credentials are missing',async()=>{
  const t=await initializationFixture();try{
    let calls=0;
    await assert.rejects(initialize({...t.options,fetch:async()=>{calls++;return Response.json({app:'untrusted',version:'0.4.0'});}}),/Unexpected deployed/);assert.equal(calls,1);
    const result=await completeInitialization(t);await fs.unlink(result.admin);
    await assert.rejects(initialize(t.options),/Existing administrator/);
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get().n,1);
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,0);
  }finally{await t.close();}
});

test('trusted recovery preserves explicit API token policy and invalidates sessions; stale recovery does not revoke tokens',async()=>{
  const t=await initializationFixture();try{
    const files=await completeInitialization(t),owner=JSON.parse(await fs.readFile(files.admin,'utf8'));
    const call=await web(t);await call('/api/auth/login',owner);
    const token=(await call('/api/tokens',{label:'Manually issued',role:'all_writer',expiresInDays:null})).token;
    const hash=await hashPassword('Recovery test 12345');
    t.f.db.exec(recoverySql({hash,version:2}));
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n,0);
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,200);
    assert.equal(await verifyPassword('Recovery test 12345',t.f.db.prepare('SELECT password_hash FROM web_admin').get().password_hash),true);
    const later=await hashPassword('Recovery next 67890');
    t.f.db.exec(recoverySql({hash:later,version:2,revokeTokens:true}));
    assert.equal(t.f.db.prepare('SELECT password_version FROM web_admin').get().password_version,3);
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,200);
    t.f.db.exec(recoverySql({hash:later,version:3,username:'renamed-admin',revokeTokens:true}));
    assert.equal((await api(t.f.env,'/api/me','GET',null,token)).status,401);
    assert.equal(t.f.db.prepare('SELECT username FROM web_admin').get().username,'renamed-admin');
  }finally{await t.close();}
});

test('repeated initialization leaves manually issued permanent/finite tokens and preexisting credential files untouched',async()=>{
  const t=await initializationFixture();try{
    const files=await completeInitialization(t),owner=JSON.parse(await fs.readFile(files.admin,'utf8'));
    const call=await web(t);await call('/api/auth/login',owner);
    const permanent=await call('/api/tokens',{label:'Chosen shared editor',role:'shared_writer',expiresInDays:null});
    const finite=await call('/api/tokens',{label:'Chosen private editor',role:'all_writer',expiresInDays:30});
    await call('/api/auth/logout',{});
    const before=t.f.db.prepare("SELECT * FROM access_tokens WHERE credential_type='api' ORDER BY id").all();
    const oldFile=path.join(t.dir,'client-b.json');await fs.writeFile(oldFile,'legacy private file must not be touched',{mode:0o600});
    assert.equal((await initialize(t.options)).status,'ready');
    assert.deepEqual(t.f.db.prepare("SELECT * FROM access_tokens WHERE credential_type='api' ORDER BY id").all(),before);
    assert.equal(await fs.readFile(oldFile,'utf8'),'legacy private file must not be touched');
    assert.equal((await api(t.f.env,'/api/me','GET',null,permanent.token)).data.expiresAt,null);
    assert.equal((await api(t.f.env,'/api/me','GET',null,finite.token)).data.expiresAt,finite.expiresAt);
  }finally{await t.close();}
});

test('obsolete automatic token options stop before network or credential writes',async()=>{
  const t=await initializationFixture();try{
    let requests=0;
    for(const tokenDays of [null,90,0,'never'])await assert.rejects(initialize({...t.options,tokenDays,fetch:async()=>{requests++;throw Error('unexpected network');}}),/issued manually/);
    assert.equal(requests,0);await assert.rejects(fs.access(path.join(t.dir,'web-admin.json')),{code:'ENOENT'});
  }finally{await t.close();}
});
