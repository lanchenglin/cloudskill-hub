import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {pack} from '../public/lib/archive.js';
const text=x=>Buffer.from(x).toString('base64');
async function prepared(){
  const f=fixture();f.admin=await setup(f.env);
  for(const slug of ['collection','hidden-project'])assert.equal((await api(f.env,'/api/projects','POST',{slug,title:slug},f.admin)).status,201);
  for(const [project,name,visibility,body] of [['collection','shared-demo','public','Public instructions'],['collection','private-demo','private','PRIVATE_FIXTURE_VALUE'],['hidden-project','hidden-demo','private','HIDDEN_FIXTURE_VALUE']]){
    const r=await api(f.env,`/api/projects/${project}/skills/${name}`,'POST',{files:skill(name,{'references/info.txt':text(body)}),visibility},f.admin);
    assert.equal(r.status,201,JSON.stringify(r.data));
  }
  return f;
}
async function mint(f,role){const r=await api(f.env,'/api/tokens','POST',{label:role,role,expiresInDays:null},f.admin);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function binary(f,path,token){const r=await handler(new Request('https://hub.example'+path,{headers:token?{Authorization:'Bearer '+token}:{}}),f.env);await r.body?.cancel();return r.status;}
async function upload(f,identity,name,visibility,baseVersion=0){
  const pkg=await pack([{name:'SKILL.md',blob:new Blob([`---\nname: ${name}\ndescription: Sharing fixture.\n---\n${name}\n`])}]);
  const begun=await api(f.env,`/api/projects/collection/skills/${name}/uploads`,'POST',{...pkg.manifest,visibility,baseVersion},identity.token);
  return {pkg,begun};
}

test('anyone can list/install shared data without a token; no private metadata, files or management routes',async()=>{
  const f=await prepared();try{
    const pub=await api(f.env,'/api/public/catalog');assert.equal(pub.status,200);assert.deepEqual(pub.data.skills.map(s=>s.slug),['shared-demo']);
    assert.ok(!JSON.stringify(pub.data).includes('private-demo'));
    const projects=await api(f.env,'/api/public/projects');assert.deepEqual(projects.data.projects.map(p=>p.slug),['collection']);
    assert.equal((await api(f.env,'/api/public/me')).data.role,'guest');
    assert.equal((await api(f.env,'/api/public/capabilities')).status,200);
    assert.equal((await api(f.env,'/api/public/projects/collection/skills/shared-demo/versions/1?format=manifest')).status,200);
    assert.equal(await binary(f,'/api/public/projects/collection/skills/shared-demo/download'),200);
    for(const suffix of ['download','versions','versions/1?format=manifest','versions/1/download','versions/1/file?path=references/info.txt'])
      assert.equal(await binary(f,'/api/public/projects/collection/skills/private-demo/'+suffix),404,suffix);
    assert.equal((await api(f.env,'/api/catalog')).status,401);
    for(const route of ['/api/public/tokens','/api/public/audit','/api/public/devices','/api/public/uploads','/api/public/auth/session'])assert.equal((await api(f.env,route)).status,404,route);
    assert.equal((await api(f.env,'/api/public/projects','POST',{slug:'no',title:'no'})).status,401);
  }finally{f.close();}
});

test('website/API issue exactly shared_writer and all_writer; no device/project assignment and no privilege escalation',async()=>{
  const f=await prepared();try{
    const shared=await mint(f,'shared_writer'),all=await mint(f,'all_writer');
    for(const c of [shared,all]){assert.equal(c.expiresAt,null);assert.deepEqual(c.projects,[]);assert.equal((await api(f.env,'/api/me','GET',null,c.token)).data.role,c.role);}
    for(const role of ['admin','publisher','client','guest','unknown'])assert.equal((await api(f.env,'/api/tokens','POST',{label:'invalid',role},f.admin)).status,400);
    assert.equal((await api(f.env,'/api/tokens','POST',{label:'ambiguous',role:'all_writer',projects:['collection']},f.admin)).status,400);
    for(const c of [shared,all])for(const [route,method,body] of [['/api/tokens','GET'],['/api/tokens','POST',{label:'escalate',role:'all_writer'}],['/api/projects','POST',{slug:'unasked',title:'no'}],['/api/audit','GET'],['/api/devices','GET'],['/api/uploads/cleanup','POST',{}]])
      assert.equal((await api(f.env,route,method,body,c.token)).status,403,route);
    assert.equal((await api(f.env,'/api/tokens','POST',{label:'bad bearer',role:'all_writer'},'invalid')).status,401);
  }finally{f.close();}
});

test('shared writer edits and creates only public skills, cannot inspect or make a private skill public',async()=>{
  const f=await prepared();try{
    const c=await mint(f,'shared_writer');
    assert.deepEqual((await api(f.env,'/api/catalog','GET',null,c.token)).data.skills.map(s=>s.slug),['shared-demo']);
    for(const route of ['/api/projects/collection/skills/private-demo/versions','/api/projects/collection/skills/private-demo/versions/1?format=manifest','/api/projects/hidden-project/skills/hidden-demo/download'])assert.equal(await binary(f,route,c.token),404);
    let r=await api(f.env,'/api/projects/collection/skills/shared-demo','POST',{files:skill('shared-demo',{'notes.txt':text('Shared edit')})},c.token);
    assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.version,2);
    r=await api(f.env,'/api/projects/collection/skills/new-shared','POST',{files:skill('new-shared')},c.token);assert.equal(r.status,201);
    assert.equal(f.db.prepare("SELECT visibility FROM skills WHERE slug='new-shared'").get().visibility,'public');
    assert.equal((await api(f.env,'/api/projects/collection/skills/private-demo','POST',{files:skill('private-demo'),visibility:'public'},c.token)).status,404);
    assert.equal((await api(f.env,'/api/projects/collection/skills/shared-demo','POST',{files:skill('shared-demo'),visibility:'private'},c.token)).status,403);
    assert.equal((await api(f.env,'/api/projects/collection/skills/new-private','POST',{files:skill('new-private'),visibility:'private'},c.token)).status,403);
  }finally{f.close();}
});

test('all writer reads and updates both visibilities across projects, with private-by-default new uploads',async()=>{
  const f=await prepared();try{
    const c=await mint(f,'all_writer');
    assert.equal((await api(f.env,'/api/catalog','GET',null,c.token)).data.skills.length,3);
    for(const [p,s] of [['collection','shared-demo'],['collection','private-demo'],['hidden-project','hidden-demo']]){
      assert.equal(await binary(f,`/api/projects/${p}/skills/${s}/download`,c.token),200);
      assert.equal((await api(f.env,`/api/projects/${p}/skills/${s}`,'POST',{files:skill(s,{'note.txt':text('Edited')})},c.token)).status,201);
    }
    assert.equal(f.db.prepare("SELECT visibility FROM skills WHERE slug='shared-demo'").get().visibility,'public');
    assert.equal((await api(f.env,'/api/projects/collection/skills/new-private','POST',{files:skill('new-private')},c.token)).status,201);
    assert.equal(f.db.prepare("SELECT visibility FROM skills WHERE slug='new-private'").get().visibility,'private');
    assert.equal((await api(f.env,'/api/projects/collection/skills/new-private','POST',{files:skill('new-private'),visibility:'public'},c.token)).status,201);
    assert.equal(await binary(f,'/api/public/projects/collection/skills/new-private/download'),200);
  }finally{f.close();}
});

test('binary shared upload rechecks visibility at status, upload and finalize, and revocation remains effective',async()=>{
  const f=await prepared();try{
    const c=await mint(f,'shared_writer');
    const {pkg,begun}=await upload(f,c,'shared-demo','public',1);assert.equal(begun.status,201);
    const id=begun.data.id;
    // Owner makes the target private before the writer has uploaded or committed.
    f.db.prepare("UPDATE skills SET visibility='private' WHERE slug='shared-demo'").run();
    assert.equal((await api(f.env,'/api/uploads/'+id,'GET',null,c.token)).status,404);
    const put=await handler(new Request('https://hub.example/api/uploads/'+id+'/archive',{method:'PUT',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/zip'},body:pkg.blob}),f.env);assert.equal(put.status,404);await put.body.cancel();
    assert.equal((await api(f.env,'/api/uploads/'+id+'/finalize','POST',{},c.token)).status,404);
    assert.equal(f.db.prepare("SELECT visibility FROM skills WHERE slug='shared-demo'").get().visibility,'private');
    const {pkg:next,begun:nextStart}=await upload(f,c,'zip-shared','public');assert.equal(nextStart.status,201);
    const nextId=nextStart.data.id;
    const sent=await handler(new Request('https://hub.example/api/uploads/'+nextId+'/archive',{method:'PUT',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/zip'},body:next.blob}),f.env);assert.equal(sent.status,200,await sent.text());
    assert.equal((await api(f.env,'/api/uploads/'+nextId+'/finalize','POST',{},c.token)).status,200);
    assert.equal(await binary(f,'/api/public/projects/collection/skills/zip-shared/download'),200);
    assert.equal((await api(f.env,'/api/tokens/'+c.id+'/revoke','POST',{},f.admin)).status,200);
    assert.equal((await api(f.env,'/api/catalog','GET',null,c.token)).status,401);
    assert.equal(await binary(f,'/api/public/projects/collection/skills/zip-shared/download'),200);
  }finally{f.close();}
});

test('sharing the latest version must not reveal older private archives, file names, or rollback sources',async()=>{
  const f=await prepared();try{
    const c=await mint(f,'shared_writer'),all=await mint(f,'all_writer');
    const old=f.db.prepare("SELECT archive_digest FROM skill_versions WHERE slug='private-demo' AND version=1").get().archive_digest;
    assert.equal((await api(f.env,'/api/projects/collection/skills/private-demo','POST',{files:skill('private-demo'),visibility:'public'},all.token)).status,201);
    for(const prefix of ['/api/public','/api']){
      const token=prefix==='/api'?c.token:null;
      const history=await api(f.env,prefix+'/projects/collection/skills/private-demo/versions','GET',null,token);assert.deepEqual(history.data.versions.map(v=>v.version),[2]);
      assert.equal(await binary(f,prefix+'/projects/collection/skills/private-demo/versions/1/download',token),404);
      assert.equal(await binary(f,prefix+'/projects/collection/skills/private-demo/versions/1/file?path=references/info.txt',token),404);
    }
    assert.equal(await binary(f,'/.well-known/agent-skills/private-demo/'+old+'.zip'),404);
    assert.equal((await api(f.env,'/api/projects/collection/skills/private-demo/rollback','POST',{version:1},c.token)).status,404);
    assert.equal(await binary(f,'/api/projects/collection/skills/private-demo/versions/1/download',all.token),200);
    assert.equal((await api(f.env,'/api/projects/collection/skills/private-demo','POST',{files:skill('private-demo'),visibility:'private'},all.token)).status,201);
    assert.equal(await binary(f,'/api/public/projects/collection/skills/private-demo/versions/2/download'),404);
    assert.equal(await binary(f,'/.well-known/skills/private-demo/SKILL.md'),404);
  }finally{f.close();}
});
