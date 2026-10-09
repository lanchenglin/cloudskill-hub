import {downloadPackage} from './transfer.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { normalizedFiles, fileDigest, slug, safePath, decode64, encode64 } from '../src/core.js';

export const AGENTS = ['claude','codex','hermes'];
const USER_HOME = () => process.env.CLOUDSKILL_HOME || os.homedir();
const limit = 9*1024*1024;
export function configFolder() {return process.env.CLOUDSKILL_CONFIG_DIR || path.join(process.platform==='win32' ? (process.env.APPDATA||path.join(USER_HOME(),'AppData','Roaming')) : (process.env.XDG_CONFIG_HOME||path.join(USER_HOME(),'.config')),'cloudskill-hub');}
export const files = () => ({config:path.join(configFolder(),'config.json'),state:path.join(configFolder(),'state.json'),backups:path.join(configFolder(),'backups')});
export function hubOrigin(value){
  let u;try{u=new URL(value);}catch{throw Error('Specify a full https:// Hub URL');}
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw Error('Hub URL must be an HTTPS origin (HTTP localhost permitted)');
  return u.origin;
}
export function parseAgents(value){const agents=value===undefined?AGENTS:value.split(',').map(x=>x.trim());if(!agents.length||agents.some(x=>!AGENTS.includes(x))||new Set(agents).size!==agents.length)throw Error('Agents must be claude,codex,hermes (comma-separated)');return agents;}
export function targetFor(name,agent){slug(name);if(!AGENTS.includes(agent))throw Error('Unknown agent');
  const h=USER_HOME();
  if(agent==='claude')return path.join(process.env.CLAUDE_CONFIG_DIR||path.join(h,'.claude'),'skills',name);
  if(agent==='codex')return path.join(process.env.CODEX_HOME||path.join(h,'.codex'),'skills',name);
  return path.join(process.env.HERMES_HOME||path.join(h,'.hermes'),'skills',name);
}
export async function readJson(filename,fallback){try{return JSON.parse(await fs.readFile(filename,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function atomicJson(filename,obj){await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});const tmp=`${filename}.${process.pid}.${randomBytes(4).toString('hex')}`;try{await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(tmp,filename);if(process.platform!=='win32')await fs.chmod(filename,0o600);}catch(e){await fs.rm(tmp,{force:true});throw e;}}
export async function saveConfig(config){const clean={url:hubOrigin(config.url),token:config.token,device:config.device,subscriptions:config.subscriptions||[]};if(!/^csh_[a-f0-9]{48}$/.test(clean.token))throw Error('Invalid CloudSkill API token');if(!/^[a-zA-Z0-9_-]{1,80}$/.test(clean.device))throw Error('Invalid device name');await atomicJson(files().config,clean);return clean;}
export async function loadConfig(){const c=await readJson(files().config,null);if(!c)throw Error('Not configured. Run cloudskill login https://your-domain');c.url=hubOrigin(c.url);if(!/^csh_[a-f0-9]{48}$/.test(c.token))throw Error('Stored credential is invalid');if(!Array.isArray(c.subscriptions))c.subscriptions=[];return c;}
export async function loadState(){const state=await readJson(files().state,{version:1,installed:{}});if(state.version!==1||!state.installed||typeof state.installed!=='object')throw Error('Unsupported state file');return state;}
export async function request(config,method,endpoint,body=null){
  if(!endpoint.startsWith('/api/')||endpoint.startsWith('//'))throw Error('Unsafe API path');
  const res=await fetch(config.url+endpoint,{method,headers:{Authorization:`Bearer ${config.token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
  const advertised=Number(res.headers.get('content-length')||0);if(advertised>limit)throw Error('Response too large');
  const reader=res.body?.getReader();if(!reader)throw Error('Empty response');let sum=0;const blocks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;sum+=value.length;if(sum>limit){await reader.cancel();throw Error('Response exceeds size limit');}blocks.push(value);}
  const bytes=Buffer.concat(blocks,sum);let parsed;
  try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw Error(`Invalid JSON returned by Hub (HTTP ${res.status})`);}
  if(!res.ok)throw Error(`Hub HTTP ${res.status}: ${parsed.error||'Unknown error'}`);
  return parsed;
}
export async function catalog(config){return (await request(config,'GET','/api/catalog')).skills;}
export async function loadVersion(config,project,name,version){return request(config,'GET',`/api/projects/${slug(project)}/skills/${slug(name)}/versions/${version}?format=manifest`);}
export async function payloadHash(bundle){
  const {files:normal}=normalizedFiles(bundle.files,bundle.slug);const digest=await fileDigest(normal);
  if(bundle.digest!==digest)throw Error(`Integrity validation failed for ${bundle.project}/${bundle.slug}`);
  return normal;
}
async function diskFiles(root,inside=''){const results=[];
  for(const entry of await fs.readdir(path.join(root,inside),{withFileTypes:true})){
    const rel=inside?inside+'/'+entry.name:entry.name;
    safePath(rel);
    if(entry.isSymbolicLink())throw Error('Symlinks are forbidden inside managed Skills: '+rel);
    if(entry.isDirectory())results.push(...await diskFiles(root,rel));
    else if(entry.isFile())results.push(rel);
    else throw Error('Unexpected file type: '+rel);
  }
  return results.sort();
}
export async function fingerprint(dir){const rels=await diskFiles(dir),hash=createHash('sha256');
  for(const rel of rels){const bytes=await fs.readFile(path.join(dir,...rel.split('/')));hash.update(rel);hash.update('\0');hash.update(createHash('sha256').update(bytes).digest('hex'));hash.update('\0');}
  return hash.digest('hex');
}
export async function localFiles(dir){const all=await diskFiles(dir);if(!all.includes('SKILL.md'))throw Error('Missing SKILL.md in '+dir);if(all.length>200)throw Error('Too many files');const out={};let total=0;
  for(const rel of all){const content=await fs.readFile(path.join(dir,...rel.split('/')));total+=content.length;if(total>6*1024*1024)throw Error('Upload exceeds 6 MiB');out[rel]=encode64(content);}
  return out;
}
const entryKey=(project,name,agent)=>`${project}/${name}#${agent}`;
async function exists(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function ensureNoAncestorSymlink(dest){let dir=path.dirname(dest);while(dir!==path.dirname(dir)){try{const s=await fs.lstat(dir);if(s.isSymbolicLink())throw Error('Parent directory is a symlink: '+dir);}catch(e){if(e.code!=='ENOENT')throw e;}dir=path.dirname(dir);}}
async function inspectTarget(bundle,project,agent,options={}){
  const {force=false}=options, state=options.state||await loadState(), name=slug(bundle.slug), p=slug(project);
  const destination=targetFor(name,agent),id=entryKey(p,name,agent);
  const record=state.installed[id];
  const conflict=Object.values(state.installed).find(row=>row.path===destination&&row.key!==id);
  if(conflict)throw Error(`${destination} is managed by a different Skill (${conflict.key}); refusing collision`);
  await ensureNoAncestorSymlink(destination);
  const present=await exists(destination);
  if(present&&!record)throw Error(`${destination} already exists but is not managed by CloudSkill; will not overwrite`);
  if(record&&!present&&!force)throw Error(`${destination} was removed externally; use --force to restore`);
  if(record&&record.path!==destination)throw Error('Install destination changed since last sync; refusing to overwrite');
  let modified=false;
  if(present){const stat=await fs.lstat(destination);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Destination is not a regular directory');modified=(await fingerprint(destination))!==record.treeHash;
    if(modified&&!force)throw Error(`${destination} has local modifications; refusing to overwrite (use --force after review)`);
  }
  return {state,name,p,destination,id,record,present,modified,current:Boolean(record&&present&&record.digest===bundle.digest&&!modified)};
}
export async function installBundle(bundle,project,agent,options={}){
  const {dryRun=false}=options;
  const normal=bundle.format===2?null:await payloadHash(bundle);
  if(bundle.format===2&&!bundle.binaryEntries)throw Error('Binary bundle must be downloaded and verified before installation');
  const {state,name,p,destination,id,record,present,modified,current}=await inspectTarget(bundle,project,agent,options);
  if(current){
    // A rollback can reuse identical bytes under a new version number. Refresh only local metadata.
    if(!dryRun&&record.version!==bundle.version){
      state.installed[id]={...record,version:bundle.version};
      try{await atomicJson(files().state,state);}catch(error){state.installed[id]=record;throw error;}
    }
    return {status:'current',project:p,name,agent,version:dryRun?record.version:bundle.version};
  }
  if(dryRun)return {status:record?'update':'install',project:p,name,agent,version:bundle.version,modified};
  await ensureNoAncestorSymlink(destination);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  const scratch=path.join(path.dirname(destination),`.${name}-cloudskill-tmp-${randomBytes(6).toString('hex')}`);
  let backup=null,placed=false;
  try{
    await fs.mkdir(scratch,{mode:0o700});
    const entries=bundle.format===2?bundle.binaryEntries:Object.entries(normal).map(([name,content])=>({name,bytes:decode64(content),mode:420}));
    for(const entry of entries){
      safePath(entry.name);const full=path.join(scratch,...entry.name.split('/'));
      await fs.mkdir(path.dirname(full),{recursive:true});
      await fs.writeFile(full,entry.bytes??new Uint8Array(await entry.blob.arrayBuffer()),{flag:'wx',mode:entry.mode});
    }
    const treeHash=await fingerprint(scratch);
    if(present){const backupRoot=path.join(path.dirname(path.dirname(destination)),'.cloudskill-backups');await fs.mkdir(backupRoot,{recursive:true,mode:0o700});
      backup=path.join(backupRoot,`${Date.now()}-${p}-${name}-${agent}-${randomBytes(3).toString('hex')}`);
      await fs.rename(destination,backup);
    }
    await fs.rename(scratch,destination);placed=true;
    state.installed[id]={key:id,project:p,slug:name,agent,version:bundle.version,digest:bundle.digest,treeHash,path:destination,installedAt:new Date().toISOString(),backup};
    await atomicJson(files().state,state);
    return {status:record?'updated':'installed',project:p,name,agent,version:bundle.version,backup};
  }catch(e){
    await fs.rm(scratch,{recursive:true,force:true}).catch(()=>{});
    if(placed)await fs.rm(destination,{recursive:true,force:true}).catch(()=>{});
    if(backup){try{await fs.rename(backup,destination);}catch(restore){throw Error(`${e.message}; restore failed: ${restore.message}; backup remains at ${backup}`);}}
    if(record)state.installed[id]=record;else delete state.installed[id];
    throw e;
  }
}
async function applySkill(config,skill,agents,options={}){
  const results=new Map(),needed=[];
  for(const agent of agents){
    const target=await inspectTarget(skill,skill.project,agent,options);
    if(options.onlyIfChanged&&target.current&&target.record.version===skill.version)
      results.set(agent,{status:'current',project:skill.project,name:skill.slug,agent,version:skill.version});
    else if(options.dryRun)
      results.set(agent,{status:target.current?'current':target.record?'update':'install',project:skill.project,name:skill.slug,agent,version:skill.version,modified:target.modified});
    else needed.push(agent);
  }
  if(needed.length){
    const bundle=await loadVersion(config,skill.project,skill.slug,skill.version);
    if(bundle.format===2)bundle.binaryEntries=await downloadPackage(config,bundle);
    // Recheck destinations after the network round trip; never trust an old local snapshot.
    for(const agent of needed)results.set(agent,await installBundle(bundle,skill.project,agent,options));
  }
  return agents.map(agent=>results.get(agent));
}
export async function install(config,project,name,agents=AGENTS,options={}){
  const skill=(await catalog(config)).find(s=>s.project===project&&s.slug===name);
  if(!skill)throw Error(`Skill ${project}/${name} not found or not authorized`);
  // Explicit installs still verify remote bytes, even when already current. sync/update skip unchanged packages.
  return applySkill(config,skill,agents,options);
}
export async function check(config,state=null){
  state=state||await loadState();
  const rows=await catalog(config),byKey=new Map(rows.map(r=>[`${r.project}/${r.slug}`,r])),report=[];
  for(const [key,rec] of Object.entries(state.installed)){
    const cloud=byKey.get(`${rec.project}/${rec.slug}`);
    let modified;
    try{modified=(await fingerprint(rec.path))!==rec.treeHash;}catch{modified=true;}
    report.push({key,agent:rec.agent,installed:rec.version,latest:cloud?.version??null,newVersion:cloud?.digest!==rec.digest,modified,removed:!cloud});
  }
  return report;
}
export async function heartbeat(config,state=null){
  state=state||await loadState();
  const granted=new Set((await request(config,'GET','/api/projects')).projects.map(r=>r.slug));
  const installed=Object.values(state.installed).filter(r=>granted.has(r.project)).map(r=>({project:r.project,slug:r.slug,agent:r.agent,version:r.version,digest:r.digest}));
  return request(config,'POST','/api/devices/heartbeat',{deviceId:config.device,name:os.hostname(),os:`${process.platform}/${process.arch}`,agents:[...new Set(installed.map(r=>r.agent))],installs:installed});
}
export async function subscribe(config,project,agents,skills=['*']){
  slug(project);if(!Array.isArray(skills)||!skills.length||skills.some(x=>x!=='*'&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x)))throw Error('Invalid subscribed skills');
  if(!Array.isArray(agents)||!agents.length||agents.some(x=>!AGENTS.includes(x)))throw Error('Invalid agents');
  const projects=(await request(config,'GET','/api/projects')).projects;
  if(!projects.some(p=>p.slug===project))throw Error(`Project ${project} does not exist or is not granted to this token`);
  config.subscriptions=config.subscriptions.filter(x=>x.project!==project);
  config.subscriptions.push({project,agents,skills});await saveConfig(config);return config.subscriptions;
}
export async function sync(config,options={}){
  const rows=await catalog(config),result=[];
  for(const sub of config.subscriptions){
    const desired=rows.filter(r=>r.project===sub.project&&(sub.skills.includes('*')||sub.skills.includes(r.slug)));
    for(const s of desired)result.push(...await applySkill(config,s,sub.agents,{...options,onlyIfChanged:true}));
  }
  if(!options.dryRun)await heartbeat(config);
  return result;
}

export async function withLock(work){
  const lock=path.join(configFolder(),'.operation.lock');
  await fs.mkdir(configFolder(),{recursive:true,mode:0o700});
  let fd;
  try{fd=await fs.open(lock,'wx',0o600);await fd.writeFile(`${process.pid}\n`);}catch(e){
    if(e.code==='EEXIST')throw Error(`Another CloudSkill operation is running (or lock is stale): ${lock}`);
    throw e;
  }
  try{return await work();}finally{await fd.close();await fs.rm(lock,{force:true});}
}
