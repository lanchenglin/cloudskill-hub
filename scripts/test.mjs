/** Isolate regression tests from any Hermes/Claude/Codex environment that launched the AI. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cloudskill-test-env-'));
const env={...process.env};
for(const key of ['HERMES_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME','CLOUDSKILL_HOME','CLOUDSKILL_CONFIG_DIR',
  'CLOUDSKILL_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'])delete env[key];
env.CLOUDSKILL_HOME=path.join(temp,'home');env.CLOUDSKILL_CONFIG_DIR=path.join(temp,'client');
try{
  const tests=(await fs.readdir(path.join(root,'test'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>path.join(root,'test',n));
  const child=spawn(process.execPath,['--test',...tests],{cwd:root,env,stdio:'inherit'});
  process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
}finally{await fs.rm(temp,{recursive:true,force:true});}
