/** Exercise the actual local workerd/D1/R2 bindings, not the unit-test storage adapter.
 * Requires `npm install`; makes no production Cloudflare deployment or cloud API writes.
 */
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {publishSource} from '../cli/transfer.mjs';
import {install,targetFor} from '../cli/manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'csh-workerd-'));
const oldHome=process.env.CLOUDSKILL_HOME,oldConfig=process.env.CLOUDSKILL_CONFIG_DIR;
let child,logs='';
try{
  const config=JSON.parse(await fs.readFile(path.join(root,'wrangler.jsonc'),'utf8'));
  config.main=path.join(root,'src/index.js');config.assets.directory=path.join(root,'public');
  config.d1_databases[0].database_id='00000000-0000-0000-0000-000000000001';config.d1_databases[0].migrations_dir=path.join(root,'migrations');
  config.vars.BOOTSTRAP_SECRET='local-smoke-test-bootstrap-secret-not-production';delete config.triggers;
  const cfg=path.join(temp,'wrangler.json');await fs.writeFile(cfg,JSON.stringify(config));
  const cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');
  const env={...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'};
  const migration=spawnSync(process.execPath,[cli,'d1','migrations','apply','DB','--local','--config',cfg,'--persist-to',temp],{cwd:root,env,stdio:'inherit',timeout:60000});
  if(migration.status!==0)throw Error('Local D1 migrations failed');
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
  child=spawn(process.execPath,[cli,'dev','--local','--config',cfg,'--persist-to',temp,'--port',String(port),'--ip','127.0.0.1'],{cwd:root,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  child.stdout.on('data',b=>logs=(logs+b.toString()).slice(-50000));child.stderr.on('data',b=>logs=(logs+b.toString()).slice(-50000));
  const url=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('wrangler dev exited: '+logs);try{if((await fetch(url+'/healthz',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}
  if(!ready)throw Error('workerd did not start: '+logs);
  let cookie='',csrf='';
  async function api(endpoint,method='GET',body=null,token=null){
    const response=await fetch(url+endpoint,{method,headers:{'X-CloudSkill-Request':'1',Origin:url,
      ...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{Cookie:cookie,'X-CSRF-Token':csrf})},
      body:body?JSON.stringify(body):undefined,redirect:'error'});
    const data=await response.json();if(!response.ok)throw Error(`Native Worker HTTP ${response.status}: ${JSON.stringify(data)}\n${logs}`);
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    if(data.csrfToken)csrf=data.csrfToken;return data;
  }
  const password='native';
  await api('/api/auth/setup','POST',{secret:config.vars.BOOTSTRAP_SECRET,username:'native-admin'});
  const initial=await api('/api/auth/login','POST',{username:'native-admin',password:'lanchenglin'});
  assert.equal(initial.mustChangePassword,true);
  assert.equal((await fetch(url+'/api/catalog',{headers:{Cookie:cookie}})).status,403);
  await api('/api/auth/password','POST',{currentPassword:'lanchenglin',newPassword:password});
  const activated=await api('/api/auth/login','POST',{username:'native-admin',password});
  assert.equal(activated.mustChangePassword,false);
  assert.match(cookie,/^csh_dev_session=/);
  assert.equal((await api('/api/auth/session')).username,'native-admin');
  await api('/api/projects','POST',{slug:'devops',title:'Native test'});
  const pubRecord=await api('/api/tokens','POST',{label:'A',role:'all_writer',expiresInDays:null});
  const readerRecord=await api('/api/tokens','POST',{label:'B',role:'shared_writer',expiresInDays:null});
  assert.equal(pubRecord.expiresAt,null);assert.equal(readerRecord.expiresAt,null);
  const publisher=pubRecord.token,token=readerRecord.token;
  assert.equal((await api('/api/me','GET',null,token)).expiresAt,null);
  const finite=await api('/api/tokens','POST',{label:'Finite',role:'shared_writer',expiresInDays:30});
  assert.ok(Date.parse(finite.expiresAt)>Date.now()+29*86400000);
  const source=path.join(temp,'source');await fs.mkdir(path.join(source,'assets'),{recursive:true});
  await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: native-test\ndescription: Verify actual local Worker streams.\n---\n# Native\n');
  const bytes=randomBytes(7*1024*1024);await fs.writeFile(path.join(source,'assets','data.bin'),bytes);
  const identity={url,token:publisher};const result=await publishSource({url,token:publisher},'devops',source);assert.equal(result.version,1);
  process.env.CLOUDSKILL_HOME=path.join(temp,'home');process.env.CLOUDSKILL_CONFIG_DIR=path.join(temp,'client');
  const installed=await install(identity,'devops','native-test',['claude','codex','hermes']);assert.equal(installed.length,3);
  assert.deepEqual(await fs.readFile(path.join(targetFor('native-test','hermes'),'assets','data.bin')),bytes);
  const noOp=await publishSource({url,token:publisher},'devops',source);assert.equal(noOp.unchanged,true);
  await api('/api/tokens/'+pubRecord.id+'/revoke','POST',{});
  assert.equal((await fetch(url+'/api/me',{headers:{Authorization:'Bearer '+publisher}})).status,401);
  assert.equal((await api('/api/me','GET',null,token)).role,'shared_writer');
  const publicSource=path.join(temp,'shared-source');await fs.mkdir(publicSource);
  await fs.writeFile(path.join(publicSource,'SKILL.md'),'---\nname: native-shared\ndescription: Shared native test.\n---\nPublic instructions.\n');
  await publishSource({url,token},'devops',publicSource,{visibility:'public'});
  const anonymous=await install({url,token:null},'devops','native-shared',['hermes']);assert.equal(anonymous[0].status,'installed');
  assert.equal((await fetch(url+'/api/public/projects/devops/skills/native-test/download')).status,404);
  await api('/api/uploads/cleanup','POST',{});
  await api('/api/auth/password','POST',{currentPassword:password,newPassword:'Native changed 67890'});
  assert.equal((await fetch(url+'/api/auth/session',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await api('/api/me','GET',null,token)).role,'shared_writer');
  await api('/api/auth/login','POST',{username:'native-admin',password:'Native changed 67890'});
  await api('/api/auth/logout','POST',{});
  const recoveryFile=path.join(temp,'recovery-password.json');
  await fs.writeFile(recoveryFile,JSON.stringify({password:'reset6'}),{mode:0o600});
  const recovery=spawnSync(process.execPath,[path.join(root,'scripts/reset-password.mjs'),'--local','--config',cfg,'--persist-to',temp,'--password-file',recoveryFile],{cwd:root,env,encoding:'utf8',timeout:60000});
  if(recovery.status!==0)throw Error('Native local recovery CLI failed: '+recovery.stderr);
  assert.ok(!recovery.stdout.includes('reset6'));
  await api('/api/auth/login','POST',{username:'native-admin',password:'reset6'});
  await api('/api/auth/logout','POST',{});
  console.log('PASS: native workerd 6-character first password/recovery and 20-character normal change; scrypt, default login/forced activation/rotation/logout/recovery CLI, shared/all tokens + anonymous binary install + independent revocation, D1 migrations, 7 MiB R2 upload, 3-agent install, idempotence and cleanup');
}catch(error){console.error(logs);throw error;}
finally{
  if(child&&child.exitCode===null){try{process.platform==='win32'?child.kill():process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>{if(child.exitCode!==null)return r();const t=setTimeout(r,5000);child.once('exit',()=>{clearTimeout(t);r();});});if(child.exitCode===null){try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}}}
  if(oldHome===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=oldHome;
  if(oldConfig===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=oldConfig;
  await fs.rm(temp,{recursive:true,force:true});
}
