#!/usr/bin/env node
/** Explicit post-deployment initialization. No automatic cloud deployment or credential search. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validatePassword,validateUsername,INITIAL_ADMIN_PASSWORD} from '../src/password.js';
import {hubOrigin} from '../cli/manager.mjs';
function accountPassword(value,existing=false){
  if(!existing)return validatePassword(value);
  // Login compatibility only: do not reject old saved credentials under the new-password policy.
  if(typeof value!=='string'||![...value].length||[...value].length>128)throw Error('Invalid saved account password');
  return value;
}
const root=fileURLToPath(new URL('../',import.meta.url));
async function read(file){
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Credential must be a small regular file');return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function outside(file){
  const rel=path.relative(root,path.resolve(file));
  if(!(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)))throw Error('Credentials must be stored outside the Git repository');
}
async function save(file,data){
  const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(data,null,2)+'\n');await h.sync();}finally{await h.close();}
}
export async function initialize(options){
  if(Object.hasOwn(options,'tokenDays'))throw Error('Tokens are now issued manually on the website. Choose their lifetime there; --token-days is no longer an initialization option.');
  const url=hubOrigin(options.url),dir=path.resolve(options.dir);outside(dir);
  const fetcher=options.fetch||globalThis.fetch,report=options.report||console.log;
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const dirStat=await fs.lstat(dir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink())throw Error('Credential directory must be a regular directory');
  if(process.platform!=='win32'&&(dirStat.mode&0o077)!==0)throw Error('Credential directory must have mode 0700');
  const lockPath=path.join(dir,'initialize.lock'),lock=await fs.open(lockPath,'wx',0o600);
  let cookie='',csrfToken='';
  async function api(endpoint,method='GET',body,token){
    const response=await fetcher(url+endpoint,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/json',Origin:url,'X-CloudSkill-Request':'1',
        ...(body!==undefined?{'Content-Type':'application/json'}:{}),
        ...(token?{Authorization:'Bearer '+token}:cookie?{Cookie:cookie,'X-CSRF-Token':csrfToken}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();throw Error(`Hub ${endpoint}: HTTP ${response.status}. Check saved credentials and instance state; do not reset or retry blindly.`);}
    const contentLength=Number(response.headers.get('content-length')||0);
    if(contentLength>1024*1024){await response.body?.cancel();throw Error('Unexpectedly large initialization response');}
    const reader=response.body.getReader(),parts=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();throw Error('Initialization response too large');}parts.push(value);}}
    finally{reader.releaseLock();}
    let data;try{data=JSON.parse(Buffer.concat(parts,size).toString('utf8'));}catch{throw Error('Unexpected initialization response');}
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    if(data.csrfToken)csrfToken=data.csrfToken;return data;
  }
  const paths={admin:path.join(dir,'web-admin.json')};
  try{
    const expected=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
    const health=await api('/healthz');
    if(health.app!=='cloudskill-hub'||health.version!==expected)throw Error('Unexpected deployed application/version; no credentials sent');
    const status=await api('/api/auth/status');
    let account=await read(paths.admin),supplied=null,replaceSaved=false;
    if(options.passwordFile){
      outside(options.passwordFile);supplied=await read(path.resolve(options.passwordFile));
      if(!supplied||typeof supplied.password!=='string')throw Error('Provided password file is missing or invalid');
      if(supplied.url&&supplied.url!==url)throw Error('Provided account belongs to a different Hub');
      accountPassword(supplied.password,status.initialized);
    }
    if(account&&supplied){
      if(account.url!==url)throw Error('Saved web account belongs to a different Hub');
      account={url,username:validateUsername(options.username||supplied.username||account.username),password:supplied.password};
      replaceSaved=true; // Persist only AFTER the remote password has been verified.
    }
    if(!account){
      if(status.initialized&&!supplied)throw Error('Existing administrator requires its saved/provided password; bootstrap cannot reset it');
      const username=validateUsername(options.username||supplied?.username||'admin');
      const password=supplied?.password??INITIAL_ADMIN_PASSWORD;accountPassword(password,status.initialized);
      account={url,username,password};
      // Persist generated credentials before creating the account so a lost HTTP response is recoverable.
      await save(paths.admin,account);
    }
    if(account.url!==url)throw Error('Saved web account belongs to a different Hub');
    validateUsername(account.username);accountPassword(account.password,status.initialized);
    if(!status.initialized){
      let token,secret;
      if(status.legacyConversion){
        if(!options.legacyAdminFile)throw Error('Legacy conversion needs --legacy-admin-file pointing to the original administrator credential');
        outside(options.legacyAdminFile);const old=await read(path.resolve(options.legacyAdminFile));
        if(old?.url!==url||!/^csh_[a-f0-9]{48}$/.test(old?.token||''))throw Error('Invalid original administrator credential');token=old.token;
      }else{
        const bootstrap=await read(path.join(dir,'bootstrap.json'));secret=bootstrap?.BOOTSTRAP_SECRET;
        if(typeof secret!=='string'||secret.length<24)throw Error('Missing protected bootstrap.json from the authorized deployment');
      }
      await api('/api/auth/setup','POST',{username:account.username,password:account.password,...(secret?{secret}:{})},token);
    }
    await api('/api/auth/login','POST',{username:account.username,password:account.password});
    const session=await api('/api/auth/session');
    if(session.username!==account.username)throw Error('Web account verification failed');
    if(replaceSaved){
      const temporary=paths.admin+'.verified-'+process.pid;
      try{await save(temporary,account);await fs.rename(temporary,paths.admin);}finally{await fs.rm(temporary,{force:true});}
    }
    if(session.mustChangePassword){
      report('Administrator initialized; FIRST PASSWORD CHANGE REQUIRED: '+url);
      report('Web username: '+account.username);report('Initial password file: '+paths.admin);
      report('Sign in on the website and choose a new password. No project or API token has been created.');
      report('The first password change needs only the current and new passwords; no bootstrap secret or ownership proof.');
      report('After changing it, create tokens yourself under Access permissions on the website. The installer never creates tokens.');
      return {...paths,status:'password_change_required'};
    }
    const projects=await api('/api/projects');
    if(!projects.projects.some(p=>p.slug==='personal'))await api('/api/projects','POST',{slug:'personal',title:'个人技能'});
    // Tokens are deliberately NOT issued here. The owner chooses the permission and expiry on the website.
    // Explicitly end this installer's web session; do not save cookies next to long-lived credentials.
    await api('/api/auth/logout','POST',{});cookie='';csrfToken='';
    report('Hub initialized and verified: '+url);
    report('Web username: '+account.username);
    report('Web password file: '+paths.admin);
    report('No API tokens were created, changed, or revoked. Issue shared-writer or all-writer tokens yourself on the website; shared downloads need no token.');
    return {...paths,status:'ready'};
  }finally{
    if(cookie&&csrfToken){try{await api('/api/auth/logout','POST',{});}catch{report('Warning: installer logout could not be confirmed; the session is time-limited.');}}
    await lock.close();await fs.unlink(lockPath);
  }
}
function argumentsOf(args){
  const result={url:process.env.CSH_HUB_URL,dir:process.env.CSH_DEPLOY_DIR};
  const keys={'--url':'url','--credentials-dir':'dir','--username':'username','--password-file':'passwordFile','--legacy-admin-file':'legacyAdminFile'};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){result.help=true;continue;}
    const field=keys[args[i]];if(!field||!args[i+1]||args[i+1].startsWith('--'))throw Error('Unknown or incomplete option: '+args[i]);result[field]=args[++i];
  }
  return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  (async()=>{const o=argumentsOf(process.argv.slice(2));
    if(o.help){console.log('Usage: node scripts/initialize-hub.mjs --url https://YOUR-HUB --credentials-dir /PRIVATE/DIRECTORY [--username admin] [--password-file /PRIVATE/account.json] [--legacy-admin-file /PRIVATE/owner.json]\nCreates a first-login account, then stops until its password is changed (exit 2). Rerun with the verified new password only to verify setup/create the personal project. Issue tokens manually on the website; none are issued by this script. Credentials stay outside Git. Not a Cloudflare deployment command.');return;}
    if(!o.url||!o.dir)throw Error('Provide the verified Hub URL and an external private credential directory');const result=await initialize(o);if(result.status==='password_change_required')process.exitCode=2;
  })().catch(error=>{console.error('Initialization stopped:',error.message);process.exitCode=1;});
}
