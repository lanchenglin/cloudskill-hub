import {GUEST,sharedOnly,canReadSkill,readSkill,defaultVisibility,tokenRole} from './skill-permissions.js';
import {principal,admin,access,allowed,publisher,publishVisibility,recent,issueToken,authRoutes,cleanupAuth} from './auth.js';
import {capabilities,startUpload,uploadStatus,uploadArchive,finalizeUpload,cancelUpload,cleanupUploads} from './uploads.js';
import {fileBody,versionPayload,readPackage} from './packages.js';
import { slug, normalizedFiles, decode64, frontmatter, fileDigest, tokenHash, randomId, sha256, now, invalid } from './core.js';
import { zipFiles } from './zip.js';
import {openToken,tokenKeyConfigured,tokenVaultErrorCode} from './token-vault.js';

const encoder = new TextEncoder();
const commonHeaders = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY' };
function json(value, status=200, publicRead=false) {
  return new Response(JSON.stringify(value), {status, headers: {...commonHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'}});
}
function fail(code,status=400){ const err = new Error(code);err.status=status;throw err; }
function plain(bytes, contentType, publicRead=false, filename=null) {
  const headers={...commonHeaders,'Content-Type':contentType,'Cache-Control':'private, no-store'};
  if(filename) headers['Content-Disposition']=`attachment; filename="${filename}"`;
  return new Response(bytes,{headers});
}
async function readJson(request, max=9*1024*1024) {
  if(Number(request.headers.get('content-length')||0)>max) fail('Body too large',413);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('Expected application/json',415);
  const reader=request.body?.getReader();if(!reader) fail('Empty request body');
  let total=0; const parts=[];
  while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();fail('Body too large',413);}parts.push(value);}
  const raw=new Uint8Array(total);let off=0;for(const p of parts){raw.set(p,off);off+=p.length;}
  let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('Invalid JSON');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('Expected a JSON object');
  return parsed;
}
async function queryOne(db,sql,...args){return db.prepare(sql).bind(...args).first();}
async function queryAll(db,sql,...args){const r=await db.prepare(sql).bind(...args).all();return r.results||[];}
async function queryRun(db,sql,...args){return db.prepare(sql).bind(...args).run();}
async function audit(env,actor,action,detail){await queryRun(env.DB,'INSERT INTO audit_log (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)',randomId('a_'),actor,action,JSON.stringify(detail).slice(0,1000),now());}
async function getCatalog(env,u,p){
  if(p){slug(p);access(u,p);}
  const all=await queryAll(env.DB,`SELECT s.project_slug AS project,s.slug,s.description,s.visibility,s.latest_version AS version,s.updated_at AS updated,
    v.artifact_digest AS digest,v.archive_digest AS archive_digest,v.file_names AS file_names,v.artifact_format AS format,v.raw_bytes AS bytes
    FROM skills s JOIN skill_versions v ON v.project_slug=s.project_slug AND v.slug=s.slug AND v.version=s.latest_version
    ORDER BY s.project_slug,s.slug`);
  return all.filter(r=>(!p||r.project===p)&&canReadSkill(u,r.project,r.visibility)).map(r=>({...r,files:JSON.parse(r.file_names),file_names:undefined}));
}
async function latestVersion(env,p,s,version=null){
  return queryOne(env.DB,`SELECT v.*,s.description AS skill_description,s.visibility,s.latest_version FROM skill_versions v JOIN skills s ON s.project_slug=v.project_slug AND s.slug=v.slug WHERE v.project_slug=? AND v.slug=? AND v.version=${version===null?'s.latest_version':'?'}`, ...(version===null?[p,s]:[p,s,version]));
}
async function readArtifact(env,row){const obj=await env.BUCKET.get(row.artifact_key);if(!obj)fail('Artifact unavailable',503);return JSON.parse(await obj.text());}
async function zipDownload(env,row,publicRead=false){const obj=await env.BUCKET.get(row.archive_key);if(!obj)fail('Archive unavailable',503);return plain(obj.body,'application/zip',publicRead,`${row.slug}-v${row.version}.zip`);}

async function publish(request,env,u,p,s){
  publisher(u,p);slug(p);slug(s);
  if(!await queryOne(env.DB,'SELECT slug FROM projects WHERE slug=?',p))fail('Project does not exist',404);
  const input=await readJson(request);
  const {files,meta}=normalizedFiles(input.files,s);
  const existingSkill=await queryOne(env.DB,'SELECT visibility FROM skills WHERE project_slug=? AND slug=?',p,s);
  const visibility=input.visibility??defaultVisibility(u,existingSkill?.visibility);
  if(!['public','private'].includes(visibility))fail('visibility must be public or private');
  publishVisibility(u,p,visibility,existingSkill?.visibility);
  if(visibility==='public'){
    const conflict=await queryOne(env.DB,'SELECT project_slug FROM skills WHERE slug=? AND visibility=\'public\' AND project_slug<>?',s,p);
    if(conflict)fail('Public skill name already used by another project',409);
  }
  const digest=await fileDigest(files);
  const previous=await latestVersion(env,p,s);
  if(input.baseVersion!==undefined&&input.baseVersion!==(previous?.latest_version??0))fail('Skill changed. Refresh before publishing.',409);
  if(previous?.artifact_digest===digest&&previous.visibility===visibility){
    await queryRun(env.DB,'UPDATE skills SET visibility=?,description=?,updated_at=? WHERE project_slug=? AND slug=?',visibility,meta.description,now(),p,s);
    await audit(env,u.label,'visibility_or_noop',{project:p,skill:s,visibility});
    return json({project:p,slug:s,version:previous.version,digest,unchanged:true});
  }
  const zip=zipFiles(files);const archiveDigest=await sha256(zip);
  const artifactKey=`artifacts/${digest}.json`,archiveKey=`archives/${archiveDigest}.zip`;
  await env.BUCKET.put(artifactKey,JSON.stringify(files),{httpMetadata:{contentType:'application/json'}});
  await env.BUCKET.put(archiveKey,zip,{httpMetadata:{contentType:'application/zip'}});
  const date=now();
  await queryRun(env.DB,'INSERT INTO skills (project_slug,slug,description,latest_version,visibility,updated_at) VALUES (?,?,?,0,?,?) ON CONFLICT(project_slug,slug) DO NOTHING',p,s,meta.description,visibility,date);
  const n=Number(previous?.latest_version||0)+1;
  // A unique version constraint prevents silent duplicate publication. A retry is appropriate for concurrent publishers.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO skill_versions (project_slug,slug,version,artifact_digest,archive_digest,artifact_key,archive_key,file_names,created_at,published_visibility) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(p,s,n,digest,archiveDigest,artifactKey,archiveKey,JSON.stringify(Object.keys(files)),date,visibility),
    env.DB.prepare('UPDATE skills SET description=?,latest_version=?,visibility=?,updated_at=? WHERE project_slug=? AND slug=?').bind(meta.description,n,visibility,date,p,s),
  ]);
  await audit(env,u.label,'publish',{project:p,skill:s,version:n,visibility});
  return json({project:p,slug:s,version:n,digest,archive_digest:archiveDigest},201);
}
async function rollback(request,env,u,p,s){
  publisher(u,p);const body=await readJson(request,1000);const version=body.version;
  if(!Number.isSafeInteger(version)||version<1)fail('Invalid version');
  const old=await latestVersion(env,p,s,version),cur=await latestVersion(env,p,s);
  if(!old||!cur)fail('Version not found',404);
  readSkill(u,p,cur.visibility,old.published_visibility);
  publishVisibility(u,p,cur.visibility,cur.visibility);
  if(old.artifact_digest===cur.artifact_digest)return json({unchanged:true,version:cur.version});
  if(body.baseVersion!==undefined&&body.baseVersion!==cur.latest_version)fail('Skill changed. Refresh before rollback.',409);
  const oldArtifact=await readPackage(env,old);
  const description=old.artifact_format===2?oldArtifact.description:frontmatter(new TextDecoder().decode(decode64(oldArtifact['SKILL.md']))).description;
  const n=cur.latest_version+1,dt=now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO skill_versions (project_slug,slug,version,artifact_digest,archive_digest,artifact_key,archive_key,file_names,created_at,artifact_format,raw_bytes,description,published_visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(p,s,n,old.artifact_digest,old.archive_digest,old.artifact_key,old.archive_key,old.file_names,dt,old.artifact_format,old.raw_bytes,description,cur.visibility),
    env.DB.prepare('UPDATE skills SET latest_version=?,description=?,updated_at=? WHERE project_slug=? AND slug=? AND latest_version=?').bind(n,description,dt,p,s,cur.latest_version),
  ]);
  await audit(env,u.label,'rollback',{project:p,skill:s,from:cur.version,to:version,newVersion:n});
  return json({version:n,rolledBackFrom:version,digest:old.artifact_digest},201);
}
function mime(path) {return path.endsWith('.md')?'text/markdown; charset=utf-8':path.endsWith('.json')?'application/json; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.txt')?'text/plain; charset=utf-8':'application/octet-stream';}
async function wellKnown(req,env,u){
  const path=new URL(req.url).pathname;
  const publicRows=await queryAll(env.DB,`SELECT s.project_slug,s.slug,s.description,v.archive_digest,v.archive_key,v.artifact_key,v.file_names,v.artifact_format
    FROM skills s JOIN skill_versions v ON s.project_slug=v.project_slug AND s.slug=v.slug AND s.latest_version=v.version WHERE s.visibility='public' ORDER BY s.slug`);
  if(path==='/.well-known/skills/index.json')return json({skills:publicRows.map(r=>({name:r.slug,description:r.description,files:JSON.parse(r.file_names)}))},200,true);
  if(path==='/.well-known/agent-skills/index.json'){
    const origin=new URL(req.url).origin;
    return json({$schema:'https://schemas.agentskills.io/discovery/0.2.0/schema.json',skills:publicRows.map(r=>({name:r.slug,description:r.description,type:'archive',url:`${origin}/.well-known/agent-skills/${r.slug}/${r.archive_digest}.zip`,digest:`sha256:${r.archive_digest}`}))},200,true);
  }
  let m=/^\/\.well-known\/skills\/([^/]+)\/(.+)$/.exec(path);
  if(m){const s=slug(m[1]);const rel=decodeURIComponent(m[2]);
    if(!publicRows.some(r=>r.slug===s))fail('Not found',404);
    const row=publicRows.find(r=>r.slug===s);
    if(!JSON.parse(row.file_names).includes(rel))fail('Not found',404);
    return plain(await fileBody(env,row,rel),mime(rel),true);
  }
  m=/^\/\.well-known\/agent-skills\/([^/]+)\/([a-f0-9]{64})\.zip$/.exec(path);
  if(m){const row=await queryOne(env.DB,`SELECT v.*,s.visibility FROM skill_versions v JOIN skills s ON s.project_slug=v.project_slug AND s.slug=v.slug WHERE s.slug=? AND s.visibility='public' AND v.published_visibility='public' AND v.archive_digest=? LIMIT 1`,m[1],m[2]);if(!row)fail('Not found',404);
    const obj=await env.BUCKET.get(row.archive_key);if(!obj)fail('Unavailable',503);
    return plain(obj.body,'application/zip',true,`${row.slug}.zip`);
  }
  fail('Not found',404);
}

export async function handler(request,env){
  try{
    const url=new URL(request.url),method=request.method.toUpperCase();let path=url.pathname;
    if(method==='GET'&&path==='/healthz')return json({ok:true,app:'cloudskill-hub',version:'0.4.3'},200,true);
    const authResponse=await authRoutes(request,env,readJson,json);
    if(authResponse)return authResponse;
    if(method==='GET'&&path.startsWith('/.well-known/'))return await wellKnown(request,env);
    if(!path.startsWith('/api/')){
      if((method==='GET'||method==='HEAD')&&env.ASSETS){
        const asset=await env.ASSETS.fetch(request);
        const h=new Headers(asset.headers);
        Object.entries(commonHeaders).forEach(([k,v])=>h.set(k,v));
        if(h.get('content-type')?.includes('text/html'))h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        return new Response(asset.body,{status:asset.status,headers:h});
      }
      fail('Not found',404);
    }
    const publicRead=path.startsWith('/api/public/');
    let u;
    if(publicRead){
      if(method!=='GET')fail('Authentication required for modifications',401);
      path='/api/'+path.slice('/api/public/'.length);
      if(!['/api/me','/api/projects','/api/catalog','/api/skills','/api/capabilities'].includes(path)&&
          !/^\/api\/projects\/[^/]+\/skills\/[^/]+\/(download|versions(?:\/[0-9]+(?:\/(download|file))?)?)$/.test(path))fail('Not found',404);
      // Even a logged-in administrator sees only shared data through this namespace.
      u=GUEST;
    }else u=await principal(request,env);
    if(method==='GET'&&path==='/api/capabilities')return json(capabilities(env));
    if(method==='GET'&&path==='/api/uploads'){publisher(u);return json({uploads:await queryAll(env.DB,'SELECT id,project_slug AS project,skill_slug AS slug,state,base_version AS baseVersion,created_at,expires_at FROM upload_sessions WHERE token_id=? ORDER BY created_at DESC LIMIT 50',u.id)});}
    if(method==='POST'&&path==='/api/uploads/cleanup'){admin(u);return json(await cleanupUploads(env));}
    const begin=/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/uploads$/.exec(path);
    if(begin&&method==='POST'){publisher(u,slug(begin[1]));return json(await startUpload(env,u,slug(begin[1]),slug(begin[2]),await readJson(request,1024*1024)),201);}
    const upload=/^\/api\/uploads\/(up_[a-f0-9]{48})(?:\/(archive|finalize))?$/.exec(path);
    if(upload){
      if(method==='GET'&&!upload[2])return json(await uploadStatus(env,u,upload[1]));
      if(method==='DELETE'&&!upload[2])return json(await cancelUpload(env,u,upload[1]));
      if(method==='PUT'&&upload[2]==='archive')return json(await uploadArchive(env,u,upload[1],request));
      if(method==='POST'&&upload[2]==='finalize')return json(await finalizeUpload(env,u,upload[1]));
    }
    if(method==='GET'&&path==='/api/me')return json({label:u.label,role:u.role,projects:u.projects,scope:u.scope??(sharedOnly(u)?'shared':'all'),authType:u.authType,expiresAt:u.expiresAt});
    if(method==='GET'&&path==='/api/projects'){
      const rows=sharedOnly(u)
        ?await queryAll(env.DB,"SELECT p.* FROM projects p WHERE EXISTS(SELECT 1 FROM skills s WHERE s.project_slug=p.slug AND s.visibility='public' AND s.latest_version>0) ORDER BY p.slug")
        :await queryAll(env.DB,'SELECT * FROM projects ORDER BY slug');
      return json({projects:rows.filter(r=>allowed(u,r.slug))});
    }
    if(method==='POST'&&path==='/api/projects'){
      admin(u);const b=await readJson(request,4000);const p=slug(b.slug);
      if(typeof b.title!=='string'||!b.title.trim()||b.title.length>100)fail('Invalid project title');
      await queryRun(env.DB,'INSERT INTO projects (slug,title,created_at) VALUES (?,?,?)',p,b.title.trim(),now());
      await audit(env,u.label,'create_project',{project:p});return json({slug:p,title:b.title.trim()},201);
    }
    if(method==='GET'&&(path==='/api/catalog'||path==='/api/skills'))return json({skills:await getCatalog(env,u,url.searchParams.get('project'))});
    if(method==='GET'&&path==='/api/tokens'){
      admin(u);const rows=await queryAll(env.DB,`SELECT id,label,role,can_publish,permission_mode,project_scope,created_at,revoked_at,expires_at,last_used_at,CASE WHEN token_ciphertext IS NOT NULL THEN 1 ELSE 0 END AS recoverable FROM access_tokens WHERE credential_type='api' ORDER BY created_at DESC`);
      return json({tokens:rows.map(r=>({...r,role:tokenRole(r),recoverable:Boolean(r.recoverable)})),tokenStorage:{configured:tokenKeyConfigured(env)}});
    }
    if(method==='POST'&&path==='/api/tokens'){
      recent(u);const b=await readJson(request,4096);const token=await issueToken(env,b.label,b.role,b.projects??[],b.expiresInDays);
      await audit(env,u.label,'issue_token',{role:b.role,label:b.label});return json(token,201);
    }
    const reveal=/^\/api\/tokens\/([a-zA-Z0-9_-]+)\/reveal$/.exec(path);
    if(reveal&&method==='POST'){
      admin(u);
      // API credentials, including retained legacy API-admin tokens, cannot reveal secrets.
      if(u.authType!=='session')fail('Web administrator session required',403);
      recent(u);await readJson(request,1024);
      const row=await queryOne(env.DB,"SELECT id,token_hash,token_ciphertext,expires_at,revoked_at FROM access_tokens WHERE id=? AND credential_type='api'",reveal[1]);
      if(!row)fail('Token not found',404);
      if(row.token_ciphertext===null)fail('token_value_unavailable',409);
      const token=await openToken(env,row.id,row.token_hash,row.token_ciphertext);
      await audit(env,u.label,'reveal_token',{id:row.id});
      // Viewing never changes validity. Retained expired/revoked values are for inspection only.
      return json({id:row.id,token,expiresAt:row.expires_at,revokedAt:row.revoked_at,
        active:!row.revoked_at&&(row.expires_at===null||Date.parse(row.expires_at)>Date.now())});
    }
    let m=/^\/api\/tokens\/([a-zA-Z0-9_-]+)\/revoke$/.exec(path);
    if(m&&method==='POST'){
      recent(u);if(m[1]===u.id)fail('Cannot revoke the token currently in use');
      const row=await queryOne(env.DB,"SELECT role FROM access_tokens WHERE id=? AND credential_type='api' AND revoked_at IS NULL",m[1]);if(!row)fail('Token not found',404);
      if(row.role==='admin'&&!await queryOne(env.DB,'SELECT id FROM web_admin WHERE id=1')){
        const admins=await queryOne(env.DB,'SELECT COUNT(*) AS total FROM access_tokens WHERE role=\'admin\' AND revoked_at IS NULL');
        if(admins.total<=1)fail('Cannot revoke last admin');
      }
      await queryRun(env.DB,'UPDATE access_tokens SET revoked_at=? WHERE id=?',now(),m[1]);await audit(env,u.label,'revoke_token',{id:m[1]});return json({ok:true});
    }
    if(method==='GET'&&path==='/api/devices'){
      admin(u);return json({devices:await queryAll(env.DB,'SELECT d.*,t.label AS token_label FROM devices d JOIN access_tokens t ON d.token_id=t.id ORDER BY d.last_seen_at DESC')});
    }
    if(method==='POST'&&path==='/api/devices/heartbeat'){
      const b=await readJson(request,65_536);
      if(typeof b.deviceId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(b.deviceId))fail('Invalid deviceId');
      if(typeof b.name!=='string'||!b.name||b.name.length>100||!Array.isArray(b.agents)||b.agents.length>10||!Array.isArray(b.installs)||b.installs.length>300)fail('Invalid device inventory');
      for(const i of b.installs){slug(i.project);slug(i.slug);if(!allowed(u,i.project))fail('Inventory includes unauthorized project',403);if(sharedOnly(u)){const s=await queryOne(env.DB,'SELECT visibility FROM skills WHERE project_slug=? AND slug=?',i.project,i.slug);if(!s||s.visibility!=='public')fail('Inventory includes unavailable skill',403);}}
      await queryRun(env.DB,'INSERT INTO devices (token_id,device_id,device_name,os,agents,installs,last_seen_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(token_id,device_id) DO UPDATE SET device_name=excluded.device_name,os=excluded.os,agents=excluded.agents,installs=excluded.installs,last_seen_at=excluded.last_seen_at',u.id,b.deviceId,b.name,String(b.os||'unknown').slice(0,80),JSON.stringify(b.agents),JSON.stringify(b.installs),now());
      return json({ok:true});
    }
    if(method==='GET'&&path==='/api/audit'){
      admin(u);return json({events:await queryAll(env.DB,'SELECT actor,action,detail,created_at FROM audit_log ORDER BY created_at DESC LIMIT 100')});
    }
    m=/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/(rollback|download|versions)$/.exec(path);
    if(m){const p=slug(m[1]),s=slug(m[2]),action=m[3];access(u,p);
      const current=await latestVersion(env,p,s);if(!current)fail('Skill not found',404);readSkill(u,p,current.visibility,current.published_visibility);
      if(method==='POST'&&action==='rollback')return await rollback(request,env,u,p,s);
      if(method==='GET'&&action==='versions')return json({versions:await queryAll(env.DB,`SELECT version,artifact_digest AS digest,created_at FROM skill_versions WHERE project_slug=? AND slug=? ${sharedOnly(u)?"AND published_visibility='public'":''} ORDER BY version DESC`,p,s)});
      if(method==='GET'&&action==='download'){const row=await latestVersion(env,p,s);if(!row)fail('Skill not found',404);return await zipDownload(env,row);}
    }
    m=/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/versions\/([0-9]+)\/(download|file)$/.exec(path);
    if(m&&method==='GET'){
      const p=slug(m[1]),s=slug(m[2]);access(u,p);
      const row=await latestVersion(env,p,s,Number(m[3]));if(!row)fail('Version not found',404);readSkill(u,p,row.visibility,row.published_visibility);
      if(m[4]==='download')return await zipDownload(env,row);
      const relative=url.searchParams.get('path');return plain(await fileBody(env,row,relative),mime(relative));
    }
    m=/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/versions\/([0-9]+)$/.exec(path);
    if(m&&method==='GET'){
      const p=slug(m[1]),s=slug(m[2]);access(u,p);const version=Number(m[3]);
      const row=await latestVersion(env,p,s,version);if(!row)fail('Version not found',404);readSkill(u,p,row.visibility,row.published_visibility);
      return json(await versionPayload(env,row,p,s,version,url.searchParams.get('format')==='manifest'));
    }
    m=/^\/api\/projects\/([^/]+)\/skills\/([^/]+)$/.exec(path);
    if(m&&method==='POST')return await publish(request,env,u,slug(m[1]),slug(m[2]));
    fail('Not found',404);
  }catch(e){
    const status=Number(e.status)|| (String(e.message).includes('UNIQUE constraint')?409:500);
    if(status>=500)console.error('cloudskill-hub error',e);
    const response=json({error:status>=500?(tokenVaultErrorCode(e)||'Internal server error'):e.message},status);
    if(e.retryAfter)response.headers.set('Retry-After',String(e.retryAfter));
    return response;
  }
}
export default {fetch:handler,async scheduled(event,env,ctx){ctx.waitUntil(Promise.all([cleanupUploads(env),cleanupAuth(env)]));}};
