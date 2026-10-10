import {publisher,publishVisibility} from './auth.js';
import {defaultVisibility} from './skill-permissions.js';
/** Binary upload sessions, ownership, CAS publication and bounded abandoned-object cleanup. */
import {resolveLimits,problem,validateEntries} from '../public/lib/policy.js';
import {layout} from '../public/lib/archive.js';
import {putVerified} from './upload-stream.js';
import {randomId,slug,now} from './core.js';
const HOUR=3600000,TTL=HOUR,MAX_ACTIVE=3,MAX_HOURLY=20;
const one=(db,sql,...a)=>db.prepare(sql).bind(...a).first();
const run=(db,sql,...a)=>db.prepare(sql).bind(...a).run();
const keys=id=>({archive:`packages/${id}.zip`,manifest:`package-manifests/${id}.json`});

export function capabilities(env){return {version:'0.4.1',uploadProtocol:2,limits:resolveLimits(env),
  legacy:{maxFiles:200,maxBundleBytes:6*1024*1024,maxFileBytes:4*1024*1024,maxJsonBytes:9*1024*1024},
  uploads:{sessionTtlSeconds:TTL/1000,maxActive:MAX_ACTIVE,maxStartsPerHour:MAX_HOURLY,resume:'completed-archive',transport:'worker-stream-to-private-r2',zipCompression:['store','deflate']}};}
export async function startUpload(env,u,project,name,body){
  publisher(u,project);slug(project);slug(name);if(!body||typeof body!=='object'||Array.isArray(body))throw problem('Expected upload manifest object');
  const db=env.DB,limits=resolveLimits(env);
  if(!await one(db,'SELECT slug FROM projects WHERE slug=?',project))throw problem('Project not found',404);
  const shape=layout(body.files,limits),archiveDigest=body.archiveDigest;
  if(!/^[a-f0-9]{64}$/.test(archiveDigest)||body.archiveBytes!==shape.size)throw problem('Invalid archive digest/size');
  const current=await one(db,'SELECT latest_version,visibility FROM skills WHERE project_slug=? AND slug=?',project,name);
  const base=body.baseVersion??current?.latest_version??0;
  const visibility=body.visibility??defaultVisibility(u,current?.visibility);
  if(!['private','public'].includes(visibility))throw problem('Invalid visibility');
  publishVisibility(u,project,visibility,current?.visibility);
  if(!Number.isSafeInteger(base)||base<0||base!==(current?.latest_version??0))throw problem('Skill changed. Refresh before publishing.',409);
  const id=randomId('up_'),time=Date.now(),expires=time+TTL;
  const manifest={format:2,files:shape.entries,archiveDigest,archiveBytes:shape.size,rawBytes:validateEntries(shape.entries,limits)};
  const inserted=await run(db,`INSERT INTO upload_sessions (id,token_id,project_slug,skill_slug,state,manifest,visibility,base_version,created_at,expires_at)
    SELECT ?,?,?,?,'created',?,?,?,?,? WHERE
    (SELECT COUNT(*) FROM upload_sessions WHERE token_id=? AND state IN ('created','uploading','ready') AND expires_at>?)<? AND
    (SELECT COUNT(*) FROM upload_sessions WHERE token_id=? AND created_at>?)<?`,
    id,u.id,project,name,JSON.stringify(manifest),visibility,base,time,expires,u.id,time,MAX_ACTIVE,u.id,time-HOUR,MAX_HOURLY);
  if(!inserted.meta.changes)throw problem('Upload session quota reached (3 active / 20 starts per hour). Cancel unused sessions.',429);
  return {id,state:'created',baseVersion:base,expiresAt:new Date(expires).toISOString(),uploadPath:`/api/uploads/${id}/archive`,finalizePath:`/api/uploads/${id}/finalize`};
}
async function owned(env,u,id,{expired=false}={}){
  publisher(u);const row=await one(env.DB,'SELECT * FROM upload_sessions WHERE id=? AND token_id=?',id,u.id);
  if(!row)throw problem('Upload not found',404);
  publisher(u,row.project_slug);
  const current=await one(env.DB,'SELECT visibility FROM skills WHERE project_slug=? AND slug=?',row.project_slug,row.skill_slug);
  publishVisibility(u,row.project_slug,row.visibility,current?.visibility);
  if(row.state!=='committed'&&!expired&&row.expires_at<=Date.now())throw problem('Upload session expired. Start again.',410);
  if(row.state==='deleting')throw problem('Upload is being removed',410);
  return row;
}
export async function uploadStatus(env,u,id){const s=await owned(env,u,id);return {id:s.id,state:s.state,project:s.project_slug,slug:s.skill_slug,visibility:s.visibility,manifest:JSON.parse(s.manifest),baseVersion:s.base_version,expiresAt:new Date(s.expires_at).toISOString(),result:s.result?JSON.parse(s.result):null};}
export async function uploadArchive(env,u,id,request){
  const row=await owned(env,u,id),manifest=JSON.parse(row.manifest);
  if(row.state==='ready'||row.state==='committed'){await request.body?.cancel().catch(()=>{});return {id,state:row.state};}
  if(row.state!=='created')throw problem('Upload is busy or cancelled; check its status or start a new session',409);
  const lock=await run(env.DB,"UPDATE upload_sessions SET state='uploading' WHERE id=? AND state='created' AND expires_at>?",id,Date.now());
  if(!lock.meta.changes)throw problem('Upload state changed',409);
  const key=keys(id);
  try{
    const meta=await putVerified(request,env.BUCKET,key.archive,manifest,resolveLimits(env),row.skill_slug);
    await env.BUCKET.put(key.manifest,JSON.stringify({...manifest,description:meta.description}),{httpMetadata:{contentType:'application/json'}});
    const ready=await run(env.DB,"UPDATE upload_sessions SET state='ready',metadata=? WHERE id=? AND state='uploading' AND expires_at>?",JSON.stringify(meta),id,Date.now());
    if(!ready.meta.changes)throw problem('Upload expired or was cancelled before completion',410);
    return {id,state:'ready'};
  }catch(error){
    // Keep the reservation until cleanup succeeds: a parallel retry must never race an old delete.
    await env.BUCKET.delete([key.archive,key.manifest]).catch(()=>{});
    await run(env.DB,"UPDATE upload_sessions SET state='created' WHERE id=? AND state='uploading'",id);
    throw error;
  }
}
function preparedAudit(db,u,action,detail){return db.prepare('INSERT INTO audit_log (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(randomId('a_'),u.label,action,JSON.stringify(detail).slice(0,1000),now());}
export async function finalizeUpload(env,u,id){
  const s=await owned(env,u,id);if(s.state==='committed')return JSON.parse(s.result);
  if(s.state!=='ready')throw problem('Archive not ready. Upload and validate it first.',409);
  const db=env.DB,manifest=JSON.parse(s.manifest),metadata=JSON.parse(s.metadata),key=keys(id),dt=now();
  const cur=await one(db,`SELECT s.latest_version,s.visibility,v.archive_digest FROM skills s LEFT JOIN skill_versions v
    ON s.project_slug=v.project_slug AND s.slug=v.slug AND v.version=s.latest_version WHERE s.project_slug=? AND s.slug=?`,s.project_slug,s.skill_slug);
  publishVisibility(u,s.project_slug,s.visibility,cur?.visibility);
  if((cur?.latest_version??0)!==s.base_version)throw problem('Skill changed while uploading. Start a new session against the latest version.',409);
  const unchanged=cur?.archive_digest===manifest.archiveDigest&&cur.visibility===s.visibility,n=unchanged?s.base_version:s.base_version+1;
  const result={project:s.project_slug,slug:s.skill_slug,version:n,digest:manifest.archiveDigest,archive_digest:manifest.archiveDigest,format:2,unchanged:Boolean(unchanged)};
  const guard="EXISTS(SELECT 1 FROM upload_sessions WHERE id=? AND state='ready' AND expires_at>?)",at=Date.now();
  const stmts=[];
  if(unchanged){
    // Ownership + version check + session state change all happen inside this D1 batch transaction.
    stmts.push(db.prepare(`UPDATE skills SET visibility=?,description=?,updated_at=? WHERE project_slug=? AND slug=? AND latest_version=? AND ${guard}`).bind(s.visibility,metadata.description,dt,s.project_slug,s.skill_slug,s.base_version,id,at));
    stmts.push(db.prepare(`UPDATE upload_sessions SET state='committed',result=? WHERE id=? AND state='ready' AND expires_at>? AND EXISTS(SELECT 1 FROM skills WHERE project_slug=? AND slug=? AND latest_version=?)`).bind(JSON.stringify(result),id,at,s.project_slug,s.skill_slug,n));
  }else{
    stmts.push(db.prepare(`INSERT INTO skills (project_slug,slug,description,latest_version,visibility,updated_at) SELECT ?,?,?,0,?,? WHERE ${guard} ON CONFLICT(project_slug,slug) DO NOTHING`).bind(s.project_slug,s.skill_slug,metadata.description,s.visibility,dt,id,at));
    stmts.push(db.prepare(`INSERT INTO skill_versions (project_slug,slug,version,artifact_digest,archive_digest,artifact_key,archive_key,file_names,created_at,artifact_format,raw_bytes,description,published_visibility)
      SELECT project_slug,slug,latest_version+1,?,?,?,?,?,?,2,?,?,? FROM skills WHERE project_slug=? AND slug=? AND latest_version=? AND ${guard}`)
      .bind(manifest.archiveDigest,manifest.archiveDigest,key.manifest,key.archive,JSON.stringify(manifest.files.map(f=>f.name)),dt,manifest.rawBytes,metadata.description,s.visibility,s.project_slug,s.skill_slug,s.base_version,id,at));
    stmts.push(db.prepare(`UPDATE skills SET latest_version=?,description=?,visibility=?,updated_at=? WHERE project_slug=? AND slug=? AND latest_version=? AND EXISTS(SELECT 1 FROM skill_versions WHERE project_slug=? AND slug=? AND version=? AND archive_key=?)`).bind(n,metadata.description,s.visibility,dt,s.project_slug,s.skill_slug,s.base_version,s.project_slug,s.skill_slug,n,key.archive));
    stmts.push(db.prepare(`UPDATE upload_sessions SET state='committed',result=? WHERE id=? AND state='ready' AND EXISTS(SELECT 1 FROM skill_versions WHERE project_slug=? AND slug=? AND version=? AND archive_key=?)`).bind(JSON.stringify(result),id,s.project_slug,s.skill_slug,n,key.archive));
  }
  // Only successful transactions receive a publish audit row.
  stmts.push(db.prepare(`INSERT OR IGNORE INTO audit_log (id,actor,action,detail,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM upload_sessions WHERE id=? AND state='committed')`).bind('a_'+id,u.label,unchanged?'binary_noop':'binary_publish',JSON.stringify({project:s.project_slug,skill:s.skill_slug,version:n}),dt,id));
  try{await db.batch(stmts);}catch(error){
    const committed=await one(db,"SELECT result FROM upload_sessions WHERE id=? AND state='committed'",id);
    if(committed)return JSON.parse(committed.result);
    if(String(error.message).includes('UNIQUE'))throw problem('Publish conflict: another version or public Skill name already exists',409);
    throw error;
  }
  const done=await one(db,"SELECT result FROM upload_sessions WHERE id=? AND state='committed'",id);
  if(!done)throw problem('Concurrent publication or expired upload. Refresh before retrying.',409);
  // A no-op archive has no version reference. Its objects are collected by cleanupUploads later.
  return JSON.parse(done.result);
}
export async function cancelUpload(env,u,id){
  const row=await owned(env,u,id,{expired:true});if(row.state==='committed')throw problem('Published versions cannot be cancelled',409);
  const result=await run(env.DB,"UPDATE upload_sessions SET state='cancelled' WHERE id=? AND state!='committed'",id);
  if(!result.meta.changes)throw problem('Upload state changed',409);
  const key=keys(id);await env.BUCKET.delete([key.archive,key.manifest]);return {id,state:'cancelled'};
}
export async function cleanupUploads(env,time=Date.now()){
  // Bounded per invocation. No public bucket lifecycle rule can accidentally delete published archives.
  const rows=(await env.DB.prepare(`SELECT id,state FROM upload_sessions WHERE
    (state!='committed' AND expires_at<?) OR (state='committed' AND created_at<?)
    ORDER BY created_at LIMIT 10`).bind(time,time-24*HOUR).all()).results;
  let removed=0;
  for(const row of rows){
    if(row.state!=='committed'){
      const claim=await run(env.DB,"UPDATE upload_sessions SET state='deleting' WHERE id=? AND state!='committed' AND expires_at<?",row.id,time);
      if(!claim.meta.changes)continue;
    }
    const key=keys(row.id),ref=await one(env.DB,'SELECT 1 AS yes FROM skill_versions WHERE archive_key=? LIMIT 1',key.archive);
    if(!ref)await env.BUCKET.delete([key.archive,key.manifest]);
    await run(env.DB,"DELETE FROM upload_sessions WHERE id=? AND state IN ('deleting','committed')",row.id);removed++;
  }
  return {removed};
}
