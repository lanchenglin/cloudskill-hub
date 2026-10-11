import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,api,setup} from './helpers.mjs';
import {handler} from '../src/index.js';
import {pack} from '../public/lib/archive.js';

const ORIGIN='https://hub.example';
async function request(env,endpoint,method='GET',body,headers={}){
  const binary=body instanceof Blob;
  const response=await handler(new Request(ORIGIN+endpoint,{method,headers:{
    ...(body===undefined?{}:{'Content-Type':binary?'application/zip':'application/json'}),...headers,
  },body:body===undefined?undefined:binary?body:JSON.stringify(body)}),env);
  return {status:response.status,data:await response.json(),response};
}
function bundle(revision=0){
  return pack([{name:'SKILL.md',blob:new Blob([`---\nname: frequency-test\ndescription: Upload ${revision} without an hourly quota.\n---\n# Test\nRevision ${revision}\n`])}]);
}
const endpoint='/api/projects/devops/skills/frequency-test/uploads';
async function writer(env,role){
  const owner=await setup(env);
  assert.equal((await api(env,'/api/projects','POST',{slug:'devops',title:'Test'},owner)).status,201);
  const issued=await api(env,'/api/tokens','POST',{label:'Frequency regression',role,expiresInDays:null},owner);
  assert.equal(issued.status,201);return {owner,record:issued.data,headers:{Authorization:'Bearer '+issued.data.token}};
}
async function upload(env,headers,pkg,visibility){
  const created=await request(env,endpoint,'POST',{...pkg.manifest,visibility},headers);
  assert.equal(created.status,201,JSON.stringify(created.data));
  const sent=await request(env,created.data.uploadPath,'PUT',pkg.blob,headers);
  assert.equal(sent.status,200,JSON.stringify(sent.data));
  const committed=await request(env,created.data.finalizePath,'POST',{},headers);
  assert.equal(committed.status,200,JSON.stringify(committed.data));return committed.data;
}

test('capabilities explicitly advertise no hourly starts limit without altering session lifetime or size limits',async()=>{
  const f=fixture();try{
    const owner=await setup(f.env);
    for(const [route,token] of [['/api/capabilities',owner],['/api/public/capabilities',null]]){
      const response=await api(f.env,route,'GET',null,token);assert.equal(response.status,200);
      assert.equal(response.data.uploads.maxStartsPerHour,null);
      assert.equal(response.data.uploads.maxActive,3);
      assert.equal(response.data.uploads.sessionTtlSeconds,3600);
      assert.equal(response.data.limits.maxBundleBytes,50*1024*1024);
    }
  }finally{f.close();}
});

for(const [role,visibility] of [['all_writer','private'],['shared_writer','public']]){
  test(`${role} can publish 25 complete versions within one hour without waiting or rotating a token`,async()=>{
    const f=fixture();try{
      const {headers,record}=await writer(f.env,role);const started=Date.now();
      for(let i=1;i<=25;i++)assert.equal((await upload(f.env,headers,await bundle(i),visibility)).version,i);
      assert.ok(Date.now()-started<3600000,'The regression must cross the old threshold within one hour');
      const rows=f.db.prepare('SELECT state,created_at FROM upload_sessions WHERE token_id=?').all(record.id);
      assert.equal(rows.length,25);assert.ok(rows.every(row=>row.state==='committed'&&row.created_at>=started));
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get().n,25);
      assert.equal(f.db.prepare('SELECT expires_at,revoked_at FROM access_tokens WHERE id=?').get(record.id).expires_at,null);
      const guest=await api(f.env,'/api/public/catalog');
      assert.equal(guest.data.skills.length,visibility==='public'?1:0);
      if(role==='shared_writer')assert.equal((await request(f.env,endpoint,'POST',{...(await bundle(26)).manifest,visibility:'private'},headers)).status,403);
    }finally{f.close();}
  });
}

test('cancelled historical sessions never exhaust a time-window allowance or require cleanup before a new upload',async()=>{
  const f=fixture();try{
    const {headers,record}=await writer(f.env,'all_writer'),pkg=await bundle();
    for(let i=0;i<25;i++){
      const created=await request(f.env,endpoint,'POST',pkg.manifest,headers);
      assert.equal(created.status,201,`attempt ${i+1}: ${JSON.stringify(created.data)}`);
      assert.equal((await request(f.env,'/api/uploads/'+created.data.id,'DELETE',undefined,headers)).status,200);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE token_id=? AND state='cancelled'").get(record.id).n,25);
    assert.equal((await upload(f.env,headers,pkg,'private')).version,1);
  }finally{f.close();}
});

test('web administrator can restart more than 20 uploads without bypassing authentication or CSRF',async()=>{
  const f=fixture();try{
    const base={'X-CloudSkill-Request':'1',Origin:ORIGIN};
    assert.equal((await request(f.env,'/api/auth/setup','POST',{secret:f.env.BOOTSTRAP_SECRET},base)).status,201);
    async function login(password){
      const result=await request(f.env,'/api/auth/login','POST',{username:'admin',password},base);
      assert.equal(result.status,200);
      return {...base,Cookie:result.response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':result.data.csrfToken};
    }
    const initial=await login('lanchenglin');
    assert.equal((await request(f.env,'/api/auth/password','POST',{currentPassword:'lanchenglin',newPassword:'test-pass6'},initial)).status,200);
    const headers=await login('test-pass6');
    assert.equal((await request(f.env,'/api/projects','POST',{slug:'devops',title:'Test'},headers)).status,201);
    const pkg=await bundle();
    assert.equal((await request(f.env,endpoint,'POST',pkg.manifest)).status,401);
    assert.equal((await request(f.env,endpoint,'POST',pkg.manifest,{...headers,'X-CSRF-Token':'wrong'})).status,403);
    for(let i=0;i<25;i++){
      const created=await request(f.env,endpoint,'POST',pkg.manifest,headers);
      assert.equal(created.status,201,`web attempt ${i+1}: ${JSON.stringify(created.data)}`);
      assert.equal((await request(f.env,'/api/uploads/'+created.data.id,'DELETE',undefined,headers)).status,200);
    }
    assert.equal((await upload(f.env,headers,pkg,'private')).version,1);
  }finally{f.close();}
});

test('active-session capacity remains atomic per identity and frees immediately on completion or cancellation',async()=>{
  const f=fixture();try{
    const {headers,owner}=await writer(f.env,'all_writer'),pkg=await bundle();const pending=[];
    // Keep the INSERT...SELECT guard in one statement; parallel callers cannot all pass a separate count check.
    const results=await Promise.all(Array.from({length:4},()=>request(f.env,endpoint,'POST',pkg.manifest,headers)));
    for(const response of results)if(response.status===201)pending.push(response.data);
    assert.equal(pending.length,3);
    const blocked=results.find(response=>response.status===429);assert.ok(blocked);
    assert.match(blocked.data.error,/3 active/i);assert.doesNotMatch(blocked.data.error,/hour|20 starts/i);
    const other=await api(f.env,'/api/tokens','POST',{label:'Second identity',role:'all_writer'},owner);
    assert.equal((await request(f.env,endpoint,'POST',pkg.manifest,{Authorization:'Bearer '+other.data.token})).status,201);
    assert.equal((await request(f.env,pending[0].uploadPath,'PUT',pkg.blob,headers)).status,200);
    assert.equal((await request(f.env,pending[0].finalizePath,'POST',{},headers)).status,200);
    assert.equal((await request(f.env,endpoint,'POST',pkg.manifest,headers)).status,201);
    assert.equal((await request(f.env,'/api/uploads/'+pending[1].id,'DELETE',undefined,headers)).status,200);
    assert.equal((await request(f.env,endpoint,'POST',pkg.manifest,headers)).status,201);
  }finally{f.close();}
});
