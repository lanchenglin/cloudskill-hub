import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture,api,setup} from './helpers.mjs';
import {handler} from '../src/index.js';
import {cleanupUploads} from '../src/uploads.js';
import {pack,unpack} from '../public/lib/archive.js';
import {DEFAULT_LIMITS as L} from '../public/lib/policy.js';
export function source(name='test-skill',extra=[],description='Testing binary upload safely.'){
  return [{name:'SKILL.md',blob:new Blob([`---\nname: ${name}\ndescription: ${description}\nmetadata:\n  hermes:\n    tags: [test]\n---\n# ${name}\n`])},...extra];
}
async function project(env,token,p='devops'){await api(env,'/api/projects','POST',{slug:p,title:p},token);}
export async function begin(env,token,pkg,name='test-skill',extra={}){return api(env,`/api/projects/devops/skills/${name}/uploads`,'POST',{...pkg.manifest,...extra},token);}
export async function send(env,token,id,body,extra={}){
  const res=await handler(new Request(`https://hub.example/api/uploads/${id}/archive`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/zip',...extra},body,duplex:'half'}),env);
  return {status:res.status,data:await res.json()};
}
export async function publishBinary(env,token,pkg,name='test-skill',extra={}){
  const b=await begin(env,token,pkg,name,extra);assert.equal(b.status,201,JSON.stringify(b.data));
  const sent=await send(env,token,b.data.id,pkg.blob);assert.equal(sent.status,200,JSON.stringify(sent.data));
  return api(env,`/api/uploads/${b.data.id}/finalize`,'POST',{},token);
}

test('binary publish -> scoped private download -> public discovery -> retained archive -> rollback',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);
    const pkg=await pack(source('test-skill',[{name:'scripts/run.sh',blob:new Blob(['echo hello\n']),mode:493}]));
    const b=await begin(f.env,t,pkg);assert.equal(b.status,201,JSON.stringify(b.data));const id=b.data.id;
    assert.equal((await api(f.env,'/.well-known/skills/index.json')).data.skills.length,0);
    assert.equal((await api(f.env,`/api/uploads/${id}/finalize`,'POST',{},t)).status,409);
    assert.equal((await send(f.env,t,id,pkg.blob)).status,200);
    assert.equal((await api(f.env,'/api/catalog','GET',null,t)).data.skills.length,0);
    const result=await api(f.env,`/api/uploads/${id}/finalize`,'POST',{},t);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.version,1);
    const again=await api(f.env,`/api/uploads/${id}/finalize`,'POST',{},t);assert.deepEqual(again.data,result.data);
    const old=await api(f.env,'/api/projects/devops/skills/test-skill/versions/1','GET',null,t);assert.equal(old.status,426);
    const detail=await api(f.env,'/api/projects/devops/skills/test-skill/versions/1?format=manifest','GET',null,t);assert.equal(detail.data.format,2);assert.equal(detail.data.manifest.files.length,2);
    const downloaded=await handler(new Request('https://hub.example'+detail.data.downloadPath,{headers:{Authorization:`Bearer ${t}`}}),f.env);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),Buffer.from(await pkg.blob.arrayBuffer()));
    const file=await handler(new Request('https://hub.example/api/projects/devops/skills/test-skill/versions/1/file?path=scripts%2Frun.sh',{headers:{Authorization:`Bearer ${t}`}}),f.env);assert.equal(await file.text(),'echo hello\n');
    const same=await publishBinary(f.env,t,pkg,'test-skill',{visibility:'public'});assert.equal(same.data.unchanged,true);assert.equal(same.data.version,1);
    assert.equal((await api(f.env,'/.well-known/skills/index.json')).data.skills.length,1);
    const next=await pack(source('test-skill',[],'New description.'));const changed=await publishBinary(f.env,t,next);assert.equal(changed.data.version,2);
    const retained=await handler(new Request(`https://hub.example/.well-known/agent-skills/test-skill/${pkg.manifest.archiveDigest}.zip`),f.env);assert.equal(retained.status,200);await retained.body.cancel();
    const roll=await api(f.env,'/api/projects/devops/skills/test-skill/rollback','POST',{version:1,baseVersion:2},t);assert.equal(roll.data.version,3);
    const back=await api(f.env,'/api/catalog','GET',null,t);assert.equal(back.data.skills[0].description,'Testing binary upload safely.');
    const read=await handler(new Request('https://hub.example/.well-known/skills/test-skill/SKILL.md'),f.env);assert.match(await read.text(),/hermes:/);
    const hidden=await publishBinary(f.env,t,pkg,'test-skill',{visibility:'private'});assert.equal(hidden.data.unchanged,true);
    assert.equal((await handler(new Request(`https://hub.example/.well-known/agent-skills/test-skill/${pkg.manifest.archiveDigest}.zip`),f.env)).status,404);
    assert.equal((await api(f.env,`/api/uploads/${id}`,'DELETE',null,t)).status,409);
  }finally{f.close();}
});

test('stream rejects corruption, wrong size, metadata mismatch, truncation and permits safe retry',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);const pkg=await pack(source());
    const b=await begin(f.env,t,pkg);const id=b.data.id;assert.equal(b.status,201);
    const bytes=new Uint8Array(await pkg.blob.arrayBuffer());bytes[40]^=1;
    assert.equal((await send(f.env,t,id,bytes)).status,400);
    assert.equal((await api(f.env,`/api/uploads/${id}`,'GET',null,t)).data.state,'created');
    assert.equal(f.env.BUCKET.objects.size,0);
    assert.equal((await send(f.env,t,id,pkg.blob.slice(0,-1))).status,400);
    assert.equal((await send(f.env,t,id,pkg.blob,{'Content-Length':'3'})).status,413);
    assert.equal((await send(f.env,t,id,pkg.blob,{'Content-Type':'application/octet-stream'})).status,415);
    assert.equal((await send(f.env,t,id,pkg.blob)).status,200);
    const mismatch=await begin(f.env,t,pkg,'other-skill');
    assert.equal((await send(f.env,t,mismatch.data.id,pkg.blob)).status,400);
    assert.equal((await api(f.env,'/api/catalog','GET',null,t)).data.skills.length,0);
  }finally{f.close();}
});

test('session ownership, revocation, quota, expiration and garbage collection preserve published versions',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);
    const other=(await api(f.env,'/api/tokens','POST',{role:'publisher',label:'other',projects:['devops']},t)).data.token;
    const client=(await api(f.env,'/api/tokens','POST',{role:'client',label:'device',projects:['devops']},t)).data.token;
    const pkg=await pack(source());assert.equal((await begin(f.env,client,pkg)).status,403);
    const b=await begin(f.env,t,pkg),id=b.data.id;
    assert.equal((await api(f.env,`/api/uploads/${id}`,'GET',null,other)).status,404);
    assert.equal((await send(f.env,other,id,pkg.blob)).status,404);
    const b2=await begin(f.env,t,pkg),b3=await begin(f.env,t,pkg);assert.equal(b2.status,201);assert.equal(b3.status,201);
    assert.equal((await begin(f.env,t,pkg)).status,429);
    await send(f.env,t,id,pkg.blob);await api(f.env,`/api/uploads/${id}/finalize`,'POST',{},t);
    await send(f.env,t,b2.data.id,pkg.blob);
    await api(f.env,`/api/uploads/${b3.data.id}`,'DELETE',null,t);
    f.db.prepare("UPDATE upload_sessions SET expires_at=0,created_at=0 WHERE state!='committed'").run();
    assert.equal((await api(f.env,`/api/uploads/${b2.data.id}`,'GET',null,t)).status,410);
    const gc=await cleanupUploads(f.env);assert.equal(gc.removed,2);
    assert.ok(f.env.BUCKET.objects.has(`packages/${id}.zip`));assert.ok(!f.env.BUCKET.objects.has(`packages/${b2.data.id}.zip`));
    f.db.prepare('UPDATE upload_sessions SET created_at=0').run();await cleanupUploads(f.env);
    assert.ok(f.env.BUCKET.objects.has(`packages/${id}.zip`));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get().n,0);
    // Revoking an admin also prevents completion of its in-flight session.
    const pending=await begin(f.env,other,pkg);await send(f.env,other,pending.data.id,pkg.blob);
    const tokens=(await api(f.env,'/api/tokens','GET',null,t)).data.tokens;
    await api(f.env,`/api/tokens/${tokens.find(v=>v.label==='other').id}/revoke`,'POST',{},t);
    assert.equal((await api(f.env,`/api/uploads/${pending.data.id}/finalize`,'POST',{},other)).status,401);
  }finally{f.close();}
});

test('optimistic publish conflict cannot overwrite a newly published version',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);const a=await pack(source()),b=await pack(source('test-skill',[],'Second version.'));
    const first=await begin(f.env,t,a),second=await begin(f.env,t,b);
    await send(f.env,t,first.data.id,a.blob);await send(f.env,t,second.data.id,b.blob);
    assert.equal((await api(f.env,`/api/uploads/${first.data.id}/finalize`,'POST',{},t)).status,200);
    assert.equal((await api(f.env,`/api/uploads/${second.data.id}/finalize`,'POST',{},t)).status,409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get().n,1);
    assert.equal((await begin(f.env,t,b,'test-skill',{baseVersion:0})).status,409);
  }finally{f.close();}
});

test('binary upload accepts >6 MiB and capabilities drive smaller deployment-specific limits',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);
    const cap=await api(f.env,'/api/capabilities','GET',null,t);assert.equal(cap.data.limits.maxBundleBytes,50*1024*1024);
    const pkg=await pack(source('big-skill',[{name:'assets/data.bin',blob:new Blob([randomBytes(7*1024*1024)])}]));
    const pub=await publishBinary(f.env,t,pkg,'big-skill');assert.equal(pub.status,200,JSON.stringify(pub.data));
    f.env.MAX_FILE_BYTES='1024';assert.equal((await begin(f.env,t,pkg,'big-skill')).status,413);
    f.env.MAX_SKILL_FILES='0';assert.equal((await api(f.env,'/api/capabilities','GET',null,t)).status,503);
  }finally{f.close();}
});

test('50 MiB / 1000-file maximum package can be streamed and downloaded intact',async()=>{
  const f=fixture();try{
    const t=await setup(f.env);await project(f.env,t);
    const files=source('limit-test');const mdSize=files[0].blob.size;
    files.push({name:'assets/one.bin',blob:new Blob([randomBytes(20*1024*1024)])},{name:'assets/two.bin',blob:new Blob([randomBytes(20*1024*1024)])},{name:'assets/three.bin',blob:new Blob([randomBytes(10*1024*1024-mdSize)])});
    for(let i=0;i<996;i++)files.push({name:`references/empty-${i}.txt`,blob:new Blob([])});
    assert.equal(files.length,1000);const pkg=await pack(files);const result=await publishBinary(f.env,t,pkg,'limit-test');assert.equal(result.status,200);
    const row=f.db.prepare('SELECT raw_bytes,archive_key FROM skill_versions').get();assert.equal(row.raw_bytes,50*1024*1024);
    assert.equal(f.env.BUCKET.objects.get(row.archive_key).length,pkg.manifest.archiveBytes);
  }finally{f.close();}
});
