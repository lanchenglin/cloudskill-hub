#!/usr/bin/env node
/** Trusted D1 account recovery. Not a public HTTP password-reset endpoint. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {hashPassword,validateUsername,validatePassword} from '../src/password.js';
import {promptSecret} from '../cli/secret-input.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
export function recoverySql({hash,version,username,revokeTokens=false}){
  if(!/^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(version)||version<1)throw Error('Invalid recovery parameters');
  if(username!==undefined)username=validateUsername(username);
  const when=new Date().toISOString(),guard=`EXISTS(SELECT 1 FROM web_admin WHERE id=1 AND password_version=${version+1} AND password_hash=${quote(hash)})`;
  const statements=[`UPDATE web_admin SET password_hash=${quote(hash)},password_version=password_version+1,must_change_password=0,activation_secret_hash=NULL,updated_at=${quote(when)}${username===undefined?'':',username='+quote(username)} WHERE id=1 AND password_version=${version};`];
  // The migration's password-change trigger deletes all browser sessions inside the UPDATE.
  if(revokeTokens)statements.push(`UPDATE access_tokens SET revoked_at=${quote(when)} WHERE credential_type='api' AND revoked_at IS NULL AND ${guard};`);
  const detail=JSON.stringify({revokeApiTokens:revokeTokens});
  statements.push(`INSERT INTO audit_log (id,actor,action,detail,created_at) SELECT ${quote('a_recovery_'+randomBytes(12).toString('hex'))},username,'password_recovery',${quote(detail)},${quote(when)} FROM web_admin WHERE id=1 AND ${guard};`);
  return statements.join('\n')+'\n';
}
function parse(args){
  const o={};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(['--local','--remote','--revoke-tokens','--help'].includes(key)){o[key.slice(2)]=true;continue;}
    if(['--config','--password-file','--username','--persist-to'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--')){o[key.slice(2)]=args[++i];continue;}
    throw Error('Unknown or incomplete recovery option: '+key);
  }
  return o;
}
export async function main(args=process.argv.slice(2)){
  const o=parse(args);
  if(o.help){console.log('Usage: npm run reset-password -- --remote|--local [--config file] [--password-file /private/file] [--username name] [--revoke-tokens]\nRequires authorized Wrangler/D1 access. Password input is hidden; files may contain plain text or {"password":"..."}. No password or hash is printed.');return;}
  if(Boolean(o.local)===Boolean(o.remote))throw Error('Choose exactly one explicit target: --local OR --remote');
  if(o['persist-to']&&!o.local)throw Error('--persist-to is only allowed with --local');
  const cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');await fs.access(cli);
  const base=['d1','execute','DB',o.remote?'--remote':'--local','--json',...(o.config?['--config',path.resolve(o.config)]:[]),...(o['persist-to']?['--persist-to',path.resolve(o['persist-to'])]:[])];
  function execute(extra){
    const result=spawnSync(process.execPath,[cli,...base,...extra],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    if(result.status!==0)throw Error('D1 recovery command failed. Check the selected account/config and Wrangler authorization; no secret output was printed.');
    let data;try{data=JSON.parse(result.stdout);}catch{throw Error('Unexpected Wrangler JSON response; inspect the target before retrying');}
    return Array.isArray(data)?data:[data];
  }
  const rows=execute(['--command','SELECT id,username,password_version FROM web_admin WHERE id=1']).flatMap(x=>x.results||[]);
  if(rows.length!==1)throw Error('No initialized web administrator found; use the initial setup or authorized legacy conversion, not password recovery');
  const user=rows[0];let password;
  if(o['password-file']){
    const filename=path.resolve(o['password-file']),relative=path.relative(root,filename);
    if(!(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)))throw Error('Credential file must be outside the source repository');
    const stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error('Password file must be a small regular file');
    const text=await fs.readFile(filename,'utf8');
    try{const data=JSON.parse(text);password=typeof data==='object'&&data?data.password:data;}catch{password=text.replace(/\r?\n$/,'');}
  }else{
    password=await promptSecret('New administrator password (15–128 characters): ');
    if(password!==await promptSecret('Repeat new password: '))throw Error('Passwords do not match');
  }
  validatePassword(password);
  const hash=await hashPassword(password);password=undefined;
  const sql=recoverySql({hash,version:user.password_version,username:o.username,revokeTokens:Boolean(o['revoke-tokens'])});
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cloudskill-recovery-'));
  if(process.platform!=='win32')await fs.chmod(temp,0o700);
  try{
    const filename=path.join(temp,'recovery.sql');await fs.writeFile(filename,sql,{mode:0o600,flag:'wx'});
    execute(['--file',filename]);
    const check=execute(['--command',`SELECT username,password_version,CASE WHEN password_hash=${quote(hash)} THEN 1 ELSE 0 END AS matched FROM web_admin WHERE id=1`]).flatMap(x=>x.results||[])[0];
    if(!check||check.matched!==1||check.password_version!==user.password_version+1)throw Error('Recovery did not win the version check. Another administrator may have changed the account; inspect before retrying.');
    console.log('Administrator password reset:',check.username);
    console.log('All browser sessions were invalidated. API tokens:',o['revoke-tokens']?'revoked by explicit request':'unchanged');
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error('Recovery failed:',error.message);process.exitCode=1;});
