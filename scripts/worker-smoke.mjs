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
  async function api(endpoint,method='GET',body=null,token=null){const r=await fetch(url+endpoint,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(`Native Worker HTTP ${r.status}: ${JSON.stringify(data)}\n${logs}`);return data;}
  const token=(await api('/api/bootstrap','POST',{secret:config.vars.BOOTSTRAP_SECRET})).token;
  await api('/api/projects','POST',{slug:'devops',title:'Native test'},token);
  const source=path.join(temp,'source');await fs.mkdir(path.join(source,'assets'),{recursive:true});
  await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: native-test\ndescription: Verify actual local Worker streams.\n---\n# Native\n');
  const bytes=randomBytes(7*1024*1024);await fs.writeFile(path.join(source,'assets','data.bin'),bytes);
  const identity={url,token};const result=await publishSource(identity,'devops',source);assert.equal(result.version,1);
  process.env.CLOUDSKILL_HOME=path.join(temp,'home');process.env.CLOUDSKILL_CONFIG_DIR=path.join(temp,'client');
  const installed=await install(identity,'devops','native-test',['claude','codex','hermes']);assert.equal(installed.length,3);
  assert.deepEqual(await fs.readFile(path.join(targetFor('native-test','hermes'),'assets','data.bin')),bytes);
  const noOp=await publishSource(identity,'devops',source);assert.equal(noOp.unchanged,true);
  await api('/api/uploads/cleanup','POST',{},token);
  console.log('PASS: native local workerd, D1 migrations, FixedLengthStream -> private R2, 7 MiB publish, 3-agent install, idempotent publish and cleanup');
}catch(error){console.error(logs);throw error;}
finally{
  if(child&&child.exitCode===null){try{process.platform==='win32'?child.kill():process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>{if(child.exitCode!==null)return r();const t=setTimeout(r,5000);child.once('exit',()=>{clearTimeout(t);r();});});if(child.exitCode===null){try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}}}
  if(oldHome===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=oldHome;
  if(oldConfig===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=oldConfig;
  await fs.rm(temp,{recursive:true,force:true});
}
