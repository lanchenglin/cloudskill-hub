/** V2 upload/download transport. Compatible with both v1 and v2 installed versions. */
import {connectionHeaders,connectionPath} from './connection.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {openAsBlob} from 'node:fs';
import {pack,unpack,verifyPackage,validatePackageManifest,boundedBytes} from '../public/lib/archive.js';
import {HARD_LIMITS,safeFilePath,validateEntries,safeName} from '../public/lib/policy.js';
import {frontmatter} from '../public/lib/metadata.js';
import {request,catalog} from './manager.mjs';

export async function uploadSources(input,limits,onProgress=()=>{}){
  const full=path.resolve(input),stat=await fs.lstat(full);
  if(stat.isSymbolicLink())throw Error('Skill source must not be a symlink');
  if(stat.isFile()){
    if(path.extname(full).toLowerCase()!=='.zip')throw Error('Source must be a Skill directory or .zip');
    if(stat.size>limits.maxArchiveBytes)throw Error('ZIP exceeds server archive limit');
    const decoded=await unpack(await openAsBlob(full),limits,{onProgress});
    if(decoded.skipped.length)onProgress({phase:'skipped',paths:decoded.skipped});return decoded.entries;
  }
  if(!stat.isDirectory())throw Error('Invalid Skill source');
  const entries=[];let total=0,directories=0;
  async function walk(dir,rel=''){
    if(++directories>limits.maxFiles*3)throw Error('Too many nested directories');
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      const name=rel?rel+'/'+e.name:e.name;safeFilePath(name,limits);
      const full=path.join(dir,e.name);
      if(e.isSymbolicLink())throw Error('Symlinks are forbidden: '+name);
      if(e.isDirectory()){await walk(full,name);continue;}
      if(!e.isFile())throw Error('Special files are forbidden: '+name);
      const st=await fs.lstat(full);if(!st.isFile()||st.isSymbolicLink())throw Error('File type changed while reading');
      total+=st.size;
      if(st.size>limits.maxFileBytes||total>limits.maxBundleBytes||entries.length>=limits.maxFiles)throw Error('Skill exceeds server file/count/size limits');
      entries.push({name,mode:st.mode&0o111?493:420,blob:await openAsBlob(full)});
    }
  }
  await walk(full);validateEntries(entries.map(e=>({name:e.name,size:e.blob.size})),limits);return entries;
}
async function binaryPut(config,endpoint,blob,onProgress=()=>{}){
  if(!/^\/api\/uploads\/up_[a-f0-9]{48}\/archive$/.test(endpoint))throw Error('Unsafe upload path');
  let sent=0;
  const body=blob.stream().pipeThrough(new TransformStream({transform(chunk,controller){sent+=chunk.length;onProgress({phase:'upload',done:sent,total:blob.size});controller.enqueue(chunk);}}));
  const response=await fetch(config.url+endpoint,{method:'PUT',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/zip','Content-Length':String(blob.size)},body,duplex:'half',redirect:'error',signal:AbortSignal.timeout(300000)});
  const text=new TextDecoder().decode(await boundedBytes(response.body,65536));
  let data;try{data=JSON.parse(text);}catch{throw Error('Upload response is not JSON (HTTP '+response.status+')');}
  if(!response.ok)throw Error(`Hub HTTP ${response.status}: ${data.error||'Upload failed'}`);return data;
}
export async function publishSource(config,project,input,options={}){
  if(config.token===null)throw Error('A shared read-only connection cannot publish. Sign in with a write token issued on the website.');
  safeName(project);const cap=await request(config,'GET','/api/capabilities');
  if(cap.uploadProtocol!==2)throw Error('Upgrade your Hub server to v0.2.0, or explicitly use --legacy for small folders');
  // Never honor a server response above this client's tested hard limits.
  const limits={...cap.limits};for(const key of Object.keys(HARD_LIMITS))if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>HARD_LIMITS[key])throw Error('Server upload policy exceeds client safety limits');
  const progress=options.onProgress||(()=>{}),entries=await uploadSources(input,limits,progress);
  const name=frontmatter(await entries.find(e=>e.name==='SKILL.md').blob.text()).name;
  const pkg=await pack(entries,limits,progress);
  let id=options.resume,current;
  if(id){
    if(!/^up_[a-f0-9]{48}$/.test(id))throw Error('Invalid upload session id');
    current=await request(config,'GET',`/api/uploads/${id}`);
    if(current.project!==project||current.slug!==name||current.manifest.archiveDigest!==pkg.manifest.archiveDigest)throw Error('Resume session does not match these exact source files');
    // A retry must not silently keep an older public authorization when --private is requested.
    if(options.visibility!==undefined&&current.visibility!==options.visibility)
      throw Error('Resume visibility does not match the requested visibility. Cancel this session and publish again; upgrade the server if it does not report session visibility.');
    if(current.state==='committed')return current.result;
  }else{
    const latest=(await catalog(config)).find(s=>s.project===project&&s.slug===name);
    current=await request(config,'POST',`/api/projects/${project}/skills/${name}/uploads`,{...pkg.manifest,baseVersion:latest?.version??0,...(options.visibility?{visibility:options.visibility}:{})});id=current.id;
  }
  progress({phase:'session',id});
  try{
    if(current.state==='created')await binaryPut(config,`/api/uploads/${id}/archive`,pkg.blob,progress);
    else if(current.state!=='ready')throw Error('Session is '+current.state+'; check it with cloudskill uploads '+id);
    return await request(config,'POST',`/api/uploads/${id}/finalize`,{});
  }catch(error){
    // A lost HTTP response is not proof of a failed publish. Query the idempotent session first.
    let status;try{status=await request(config,'GET',`/api/uploads/${id}`);}catch{}
    if(status?.state==='committed')return status.result;
    if(status?.state==='ready'){
      try{return await request(config,'POST',`/api/uploads/${id}/finalize`,{});}catch{}
    }
    throw Error(`${error.message}\nUpload session: ${id}\nRetry the same source with --resume ${id}; cancel with cloudskill cancel-upload ${id}. An interrupted partial upload restarts in full.`);
  }
}
export async function downloadPackage(config,bundle){
  const endpoint=bundle.downloadPath;
  if(!/^\/api\/projects\/[a-z0-9-]+\/skills\/[a-z0-9-]+\/versions\/\d+\/download$/.test(endpoint))throw Error('Unsafe archive download path');
  const m=bundle.manifest;
  validatePackageManifest(m);
  if(bundle.digest!==m.archiveDigest)throw Error('Invalid package metadata: version/archive digest mismatch');
  const response=await fetch(config.url+connectionPath(config,endpoint),{headers:connectionHeaders(config),redirect:'error',signal:AbortSignal.timeout(300000)});
  if(!response.ok){await response.body?.cancel();throw Error('Archive download failed: HTTP '+response.status);}
  const advertised=Number(response.headers.get('content-length')||0);if(advertised&&advertised!==m.archiveBytes){await response.body?.cancel();throw Error('Archive length mismatch');}
  const bytes=await boundedBytes(response.body,m.archiveBytes);
  return verifyPackage(new Blob([bytes]),m);
}
