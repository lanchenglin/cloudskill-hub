import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,skill,api,setup} from './helpers.mjs';
import {legacyToken} from './helpers.mjs';
import {encode64} from '../src/core.js';
import {handler} from '../src/index.js';

const payload=(name='some-skill',v=1,visibility='private')=>({files:skill(name,{'references/intro.md':encode64(new TextEncoder().encode('Updated '+v))}),visibility});

test('private registry, scoped tokens, public well-known routes and version rollback',async()=>{
  const {env,close}=fixture();try{
    const pre=await api(env,'/.well-known/skills/index.json');assert.equal(pre.status,200);assert.deepEqual(pre.data.skills,[]);
    const bad=await api(env,'/api/bootstrap','POST',{secret:'incorrect'});assert.equal(bad.status,410);
    const admin=await setup(env);
    assert.equal((await api(env,'/api/bootstrap','POST',{secret:env.BOOTSTRAP_SECRET})).status,410);
    const tokenHeader={Authorization:'Bearer '+admin};
    assert.equal((await api(env,'/api/projects','POST',{slug:'devops',title:'DevOps'},admin)).status,201);
    assert.equal((await api(env,'/api/projects','POST',{slug:'coding',title:'Code'},admin)).status,201);
    const issued={status:201,data:await legacyToken(env,'Hermes Device','client',['devops'])};
    assert.equal(issued.status,201);const client=issued.data.token;
    assert.equal((await api(env,'/api/projects','GET',null,client)).data.projects.length,1);
    assert.equal((await api(env,'/api/projects','POST',{slug:'xyz',title:'Bad'},client)).status,403);
    assert.equal((await api(env,'/api/projects/devops/skills/some-skill','POST',payload(),client)).status,403);
    const pub=await api(env,'/api/projects/devops/skills/some-skill','POST',payload(),admin);
    assert.equal(pub.status,201);assert.equal(pub.data.version,1);
    const again=await api(env,'/api/projects/devops/skills/some-skill','POST',payload(),admin);
    assert.equal(again.status,200);assert.equal(again.data.unchanged,true);
    const anon=await api(env,'/.well-known/skills/index.json');assert.deepEqual(anon.data.skills,[]);
    assert.equal((await api(env,'/api/catalog')).status,401);
    assert.equal((await api(env,'/api/catalog','GET',null,client)).data.skills.length,1);
    const version1=await api(env,'/api/projects/devops/skills/some-skill/versions/1','GET',null,client);
    assert.equal(version1.status,200);assert.equal(version1.data.digest,pub.data.digest);
    assert.equal((await api(env,'/api/projects/coding/skills/no-skill/versions/1','GET',null,client)).status,403);
    const pub2=await api(env,'/api/projects/devops/skills/some-skill','POST',payload('some-skill',2,'public'),admin);
    assert.equal(pub2.data.version,2);
    const idx=await api(env,'/.well-known/skills/index.json');
    assert.equal(idx.data.skills[0].name,'some-skill');assert.ok(idx.data.skills[0].files.includes('SKILL.md'));
    const discovery=await api(env,'/.well-known/agent-skills/index.json');
    assert.equal(discovery.data.skills[0].digest,`sha256:${pub2.data.archive_digest}`);
    const publicText=await handler(new Request('https://hub.example/.well-known/skills/some-skill/SKILL.md'),env);
    assert.equal(publicText.status,200);assert.match(await publicText.text(),/metadata:\n  hermes:/);
    const publicZip=await handler(new Request(`https://hub.example/.well-known/agent-skills/some-skill/${pub2.data.archive_digest}.zip`),env);
    assert.equal(publicZip.status,200);const zipBytes=await publicZip.arrayBuffer();assert.ok(zipBytes.byteLength>100);
    const archiveHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',zipBytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    assert.equal(archiveHash,pub2.data.archive_digest);
    const rolled=await api(env,'/api/projects/devops/skills/some-skill/rollback','POST',{version:1},admin);assert.equal(rolled.data.version,3);
    const now=await api(env,'/api/projects/devops/skills/some-skill/versions/3','GET',null,client);assert.equal(now.data.digest,pub.data.digest);
    assert.equal((await api(env,'/api/catalog','GET',null,client)).data.skills[0].version,3);
    assert.equal((await api(env,'/.well-known/skills/index.json')).data.skills.length,1);
    const heartbeat=await api(env,'/api/devices/heartbeat','POST',{deviceId:'test-pc',name:'My PC',agents:['hermes'],installs:[{project:'devops',slug:'some-skill',version:3}]},client);
    assert.equal(heartbeat.status,200);assert.equal((await api(env,'/api/devices','GET',null,admin)).data.devices.length,1);
    const tokens=await api(env,'/api/tokens','GET',null,admin);const id=tokens.data.tokens.find(x=>x.role==='client').id;
    assert.equal((await api(env,`/api/tokens/${id}/revoke`,'POST',{},admin)).status,200);
    assert.equal((await api(env,'/api/catalog','GET',null,client)).status,401);
    assert.equal((await api(env,'/api/audit','GET',null,admin)).status,200);
  }finally{close();}
});

test('public name collision and file safety limits',async()=>{
  const {env,close}=fixture();try{
    const t=await setup(env);
    await api(env,'/api/projects','POST',{slug:'a',title:'A'},t);
    await api(env,'/api/projects','POST',{slug:'b',title:'B'},t);
    assert.equal((await api(env,'/api/projects/a/skills/some-skill','POST',payload('some-skill',1,'public'),t)).status,201);
    assert.equal((await api(env,'/api/projects/b/skills/some-skill','POST',payload('some-skill',1,'public'),t)).status,409);
    const malicious={files:skill('blocked',{'.env':'eA=='}),visibility:'private'};
    assert.equal((await api(env,'/api/projects/a/skills/blocked','POST',malicious,t)).status,400);
    assert.equal((await api(env,'/api/projects/a/skills/blocked','POST',{files:skill('oops')},t)).status,400);
  }finally{close();}
});


test('Worker static assets response receives restrictive CSP',async()=>{
  const {env,close}=fixture();try{
    env.ASSETS={fetch:async()=>new Response('<h1>Safe</h1>',{headers:{'Content-Type':'text/html; charset=utf-8'}})};
    const res=await handler(new Request('https://hub.example/'),env);
    assert.equal(res.status,200);
    assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'),'DENY');
  }finally{close();}
});
