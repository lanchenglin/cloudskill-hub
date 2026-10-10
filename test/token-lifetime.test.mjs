import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {tokenHash} from '../src/core.js';
import {SESSION_TTL,SESSION_IDLE,REAUTH_TTL} from '../src/auth.js';
import {validateTokenDays,parseTokenDaysOption} from '../src/token-policy.js';
const DAY=86400000;
async function ready(){
  const f=fixture(),admin=await setup(f.env);
  for(const slug of ['personal','other'])assert.equal((await api(f.env,'/api/projects','POST',{slug,title:slug},admin)).status,201);
  return {...f,admin};
}
const mint=(f,extra={})=>api(f.env,'/api/tokens','POST',{label:'Lifetime fixture',role:'client',projects:['personal'],...extra},f.admin);

test('explicit null issues permanent scoped tokens; omitted lifetime still defaults to 90 days',async()=>{
  const f=await ready();try{
    for(const role of ['client','publisher']){
      const response=await mint(f,{role,expiresInDays:null});assert.equal(response.status,201);
      const token=response.data;assert.equal(token.expiresAt,null);
      const record=f.db.prepare('SELECT * FROM access_tokens WHERE id=?').get(token.id);
      assert.equal(record.expires_at,null);assert.equal(record.token_hash,await tokenHash(token.token));
      const me=await api(f.env,'/api/me','GET',null,token.token);
      assert.equal(me.status,200);assert.equal(me.data.expiresAt,null);assert.equal(me.data.role,role);
      assert.deepEqual(me.data.projects,['personal']);
      const list=(await api(f.env,'/api/tokens','GET',null,f.admin)).data.tokens;
      const row=list.find(t=>t.id===token.id);assert.equal(row.expires_at,null);assert.equal(row.token,undefined);
    }
    const before=Date.now(),normal=await mint(f);assert.equal(normal.status,201);
    assert.ok(Date.parse(normal.data.expiresAt)>=before+90*DAY);
    assert.ok(Date.parse(normal.data.expiresAt)<=Date.now()+90*DAY);
  }finally{f.close();}
});

test('permanent expiry must be explicit null: invalid values are rejected without issuing a token',async()=>{
  const f=await ready();try{
    const count=()=>f.db.prepare('SELECT COUNT(*) AS n FROM access_tokens').get().n,initial=count();
    for(const expiresInDays of [0,-1,366,1.5,'never','permanent','null','90','',false,true,[],{}]){
      assert.equal((await mint(f,{expiresInDays})).status,400,JSON.stringify(expiresInDays));
      assert.equal(count(),initial);
    }
    for(const expiresInDays of [1,30,90,365]){
      const before=Date.now(),r=await mint(f,{expiresInDays});assert.equal(r.status,201);
      assert.ok(Date.parse(r.data.expiresAt)>=before+expiresInDays*DAY);
      assert.ok(Date.parse(r.data.expiresAt)<=Date.now()+expiresInDays*DAY);
    }
  }finally{f.close();}
});

test('permanent tokens preserve project scope and role; single revocation affects only that credential',async()=>{
  const f=await ready();try{
    const pub=(await mint(f,{role:'publisher',label:'A',expiresInDays:null})).data;
    const reader=(await mint(f,{label:'B',expiresInDays:null})).data;
    const body={files:skill('permanent-test'),visibility:'private'};
    assert.equal((await api(f.env,'/api/projects/personal/skills/permanent-test','POST',body,pub.token)).status,201);
    assert.equal((await api(f.env,'/api/projects/personal/skills/permanent-test','POST',body,reader.token)).status,403);
    assert.equal((await api(f.env,'/api/projects/other/skills/permanent-test','POST',body,pub.token)).status,403);
    assert.equal((await api(f.env,'/api/projects/personal/skills/permanent-test','POST',{...body,visibility:'public'},pub.token)).status,403);
    assert.equal((await api(f.env,'/api/tokens','POST',{label:'Escalation',role:'publisher',projects:['personal'],expiresInDays:null},pub.token)).status,403);
    assert.equal((await api(f.env,'/api/catalog','GET',null,reader.token)).data.skills.length,1);
    assert.equal((await api(f.env,`/api/tokens/${pub.id}/revoke`,'POST',{},f.admin)).status,200);
    assert.equal((await api(f.env,'/api/me','GET',null,pub.token)).status,401);
    assert.equal((await api(f.env,'/api/me','GET',null,reader.token)).status,200);
    assert.equal(f.db.prepare('SELECT expires_at FROM access_tokens WHERE id=?').get(reader.id).expires_at,null);
  }finally{f.close();}
});

test('old creation dates do not expire permanent tokens; expired finite and revoked tokens remain denied',async()=>{
  const f=await ready();try{
    const forever=(await mint(f,{expiresInDays:null})).data;
    const finite=(await mint(f,{expiresInDays:365})).data;
    f.db.prepare("UPDATE access_tokens SET created_at='2000-01-01T00:00:00.000Z' WHERE id IN (?,?)").run(forever.id,finite.id);
    f.db.prepare("UPDATE access_tokens SET expires_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(finite.id);
    assert.equal((await api(f.env,'/api/me','GET',null,forever.token)).status,200);
    assert.equal((await api(f.env,'/api/me','GET',null,finite.token)).status,401);
    assert.equal((await api(f.env,`/api/tokens/${forever.id}/revoke`,'POST',{},f.admin)).status,200);
    assert.equal((await api(f.env,'/api/me','GET',null,forever.token)).status,401);
    assert.equal(f.db.prepare('SELECT expires_at FROM access_tokens WHERE id=?').get(finite.id).expires_at,'2001-01-01T00:00:00.000Z');
  }finally{f.close();}
});

async function web(env,route,body,session){
  const response=await handler(new Request('https://hub.example'+route,{method:body===undefined?'GET':'POST',
    headers:{Origin:'https://hub.example','X-CloudSkill-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.data.csrfToken}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

test('permanent issuance still requires first password change, CSRF and recent verification; revoke-all still works',async()=>{
  const f=fixture();try{
    const password='Private lifetime fixture password 12345';
    assert.equal((await web(f.env,'/api/auth/setup',{secret:f.env.BOOTSTRAP_SECRET})).status,201);
    const pending=await web(f.env,'/api/auth/login',{username:'admin',password:'lanchenglin'});
    const body={label:'Forever',role:'client',projects:['personal'],expiresInDays:null};
    assert.equal((await web(f.env,'/api/tokens',body,pending)).data.error,'password_change_required');
    assert.equal((await web(f.env,'/api/auth/password',{currentPassword:'lanchenglin',newPassword:password},pending)).status,200);
    const session=await web(f.env,'/api/auth/login',{username:'admin',password});
    assert.equal((await web(f.env,'/api/projects',{slug:'personal',title:'Personal'},session)).status,201);
    assert.equal((await web(f.env,'/api/tokens',body,{...session,data:{csrfToken:'wrong'}})).status,403);
    f.db.prepare('UPDATE web_sessions SET reauthenticated_at=?').run(Date.now()-REAUTH_TTL-1);
    assert.equal((await web(f.env,'/api/tokens',body,session)).data.error,'reauth_required');
    assert.equal((await web(f.env,'/api/auth/reauth',{password},session)).status,200);
    const permanent=await web(f.env,'/api/tokens',body,session);assert.equal(permanent.status,201);assert.equal(permanent.data.expiresAt,null);
    const finite=await web(f.env,'/api/tokens',{...body,expiresInDays:30},session);assert.equal(finite.status,201);
    assert.equal((await web(f.env,'/api/auth/revoke-all-tokens',{confirm:'revoke-all-api-tokens'},session)).data.count,2);
    for(const t of [permanent,finite])assert.equal((await api(f.env,'/api/me','GET',null,t.data.token)).status,401);
    assert.equal((await web(f.env,'/api/auth/session',undefined,session)).status,200);
    assert.equal(SESSION_TTL,12*3600000);assert.equal(SESSION_IDLE,30*60000);
  }finally{f.close();}
});


test('shared lifetime validation distinguishes omission from null without coercion',()=>{
  assert.equal(validateTokenDays(),90);assert.equal(validateTokenDays(undefined),90);
  assert.equal(validateTokenDays(null),null);
  for(const days of [1,30,90,365])assert.equal(validateTokenDays(days),days);
  for(const days of [0,-1,366,Infinity,NaN,1.5,'90','never','',false,true,[],{}])
    assert.throws(()=>validateTokenDays(days),/Token lifetime/);
});

test('initializer token-days parser accepts never or days and rejects ambiguous values',()=>{
  assert.equal(parseTokenDaysOption('never'),null);
  for(const days of [1,30,90,365])assert.equal(parseTokenDaysOption(String(days)),days);
  for(const value of ['0','366','-1','1.5','1e2','Infinity','NaN','','null','false','90days',' 90','90 ','090',null,0,false])
    assert.throws(()=>parseTokenDaysOption(value));
});
