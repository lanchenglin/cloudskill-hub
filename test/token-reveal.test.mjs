import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture,api,legacyToken,setup} from './helpers.mjs';
import {handler} from '../src/index.js';
import {REAUTH_TTL} from '../src/auth.js';
import {tokenHash} from '../src/core.js';

async function web(f,route,method='GET',body,session=f.session,extra={}){
  const response=await handler(new Request('https://hub.example'+route,{method,
    headers:{Origin:'https://hub.example','X-CloudSkill-Request':'1',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.data.csrfToken}:{}),...extra},
    body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {status:response.status,data:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function ready(){
  const f=fixture();f.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  assert.equal((await web(f,'/api/auth/setup','POST',{secret:f.env.BOOTSTRAP_SECRET})).status,201);
  const first=await web(f,'/api/auth/login','POST',{username:'admin',password:'lanchenglin'});
  assert.equal((await web(f,'/api/auth/password','POST',{currentPassword:'lanchenglin',newPassword:'owner6'},first)).status,200);
  f.session=await web(f,'/api/auth/login','POST',{username:'admin',password:'owner6'});
  return f;
}
async function mint(f,role='shared_writer',expiresInDays=null){
  const r=await web(f,'/api/tokens','POST',{label:'View '+role,role,expiresInDays});
  assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
const reveal=(f,id,s=f.session,extra={})=>web(f,`/api/tokens/${id}/reveal`,'POST',{},s,extra);

test('new shared/all tokens have recoverable encrypted copies, not plaintext or ciphertext in lists',async()=>{
  const f=await ready();try{
    for(const role of ['shared_writer','all_writer']){
      const t=await mint(f,role,role==='shared_writer'?null:30);
      const row=f.db.prepare('SELECT * FROM access_tokens WHERE id=?').get(t.id);
      assert.equal(row.token_hash,await tokenHash(t.token));
      assert.match(row.token_ciphertext,/^v1:[a-f0-9]{24}:[a-f0-9]{136}$/);
      assert.ok(!JSON.stringify(row).includes(t.token));
      const list=await web(f,'/api/tokens');
      assert.equal(list.data.tokenStorage.configured,true);
      assert.equal(list.data.tokens.find(x=>x.id===t.id).recoverable,true);
      for(const forbidden of [t.token,row.token_ciphertext,row.token_hash,f.env.TOKEN_ENCRYPTION_KEY])assert.ok(!JSON.stringify(list.data).includes(forbidden));
      const viewed=await reveal(f,t.id);assert.equal(viewed.status,200,JSON.stringify(viewed.data));
      assert.equal(viewed.data.token,t.token);assert.equal(viewed.data.id,t.id);assert.equal(viewed.data.expiresAt,t.expiresAt);
      assert.match(viewed.headers.get('cache-control'),/no-store/);
      assert.equal((await reveal(f,t.id)).data.token,t.token);
      assert.equal((await api(f.env,'/api/me','GET',null,t.token)).data.role,role);
    }
    const audit=JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(audit.includes('reveal_token'));
    for(const row of f.db.prepare('SELECT token_ciphertext FROM access_tokens WHERE token_ciphertext IS NOT NULL').all())assert.ok(!audit.includes(row.token_ciphertext));
    assert.ok(!audit.includes(f.env.TOKEN_ENCRYPTION_KEY));
  }finally{f.close();}
});

test('reveal survives logout, re-login and password changes without rotating any API token',async()=>{
  const f=await ready();try{
    const t=await mint(f,'all_writer');
    assert.equal((await web(f,'/api/auth/logout','POST',{})).status,200);
    assert.equal((await reveal(f,t.id)).status,401);
    f.session=await web(f,'/api/auth/login','POST',{username:'admin',password:'owner6'});
    assert.equal((await reveal(f,t.id)).data.token,t.token);
    assert.equal((await web(f,'/api/auth/password','POST',{currentPassword:'owner6',newPassword:'owner7'})).status,200);
    f.session=await web(f,'/api/auth/login','POST',{username:'admin',password:'owner7'});
    assert.equal((await reveal(f,t.id)).data.token,t.token);
    assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,200);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,1);
  }finally{f.close();}
});

test('reveal is POST-only and requires a web admin session, CSRF, origin and recent authentication',async()=>{
  const f=await ready();try{
    const t=await mint(f),all=await mint(f,'all_writer');
    assert.equal((await reveal(f,t.id,null)).status,401);
    for(const token of [t.token,all.token,await setup(f.env)]){
      const r=await reveal(f,t.id,f.session,{Authorization:'Bearer '+token});
      assert.equal(r.status,403);assert.equal(r.data.token,undefined);
    }
    assert.equal((await reveal(f,t.id,f.session,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await reveal(f,t.id,f.session,{Origin:'https://attacker.invalid'})).status,403);
    assert.equal((await web(f,`/api/tokens/${t.id}/reveal`)).status,404);
    assert.equal((await reveal(f,'t_web_owner')).status,404);
    assert.equal((await reveal(f,'t_missing')).status,404);
    assert.equal((await web(f,`/api/public/tokens/${t.id}/reveal`,'POST',{},null)).status,401);
    f.db.prepare('UPDATE web_sessions SET reauthenticated_at=?').run(Date.now()-REAUTH_TTL-1);
    assert.equal((await reveal(f,t.id)).data.error,'reauth_required');
    assert.equal((await web(f,'/api/auth/reauth','POST',{password:'owner6'})).status,200);
    assert.equal((await reveal(f,t.id)).data.token,t.token);
    f.db.prepare('UPDATE web_admin SET must_change_password=1').run();
    assert.equal((await reveal(f,t.id)).data.error,'password_change_required');
  }finally{f.close();}
});

test('missing or invalid key blocks new issuance, never falls back to one-time or plaintext storage',async()=>{
  const f=await ready();try{
    const t=await mint(f),key=f.env.TOKEN_ENCRYPTION_KEY;
    for(const value of [undefined,'short','g'.repeat(64),false]){
      if(value===undefined)delete f.env.TOKEN_ENCRYPTION_KEY;else f.env.TOKEN_ENCRYPTION_KEY=value;
      const created=await web(f,'/api/tokens','POST',{label:'Must not exist',role:'shared_writer'});
      assert.equal(created.status,503);assert.equal(created.data.error,'token_key_unavailable');
      assert.equal((await web(f,'/api/tokens')).data.tokenStorage.configured,false);
      const r=await reveal(f,t.id);assert.equal(r.status,503);assert.equal(r.data.token,undefined);
      assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,200);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,1);
    f.env.TOKEN_ENCRYPTION_KEY=key;assert.equal((await reveal(f,t.id)).data.token,t.token);
  }finally{f.close();}
});

test('wrong key, tampered data and ciphertext copied to another token cannot expose a value',async()=>{
  const f=await ready();try{
    const a=await mint(f),b=await mint(f,'all_writer');
    const key=f.env.TOKEN_ENCRYPTION_KEY;
    const box=f.db.prepare('SELECT token_ciphertext FROM access_tokens WHERE id=?').get(a.id).token_ciphertext;
    const logs=[],oldError=console.error;console.error=(...args)=>logs.push(args.map(String).join(' '));
    try{
      f.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');
      const wrong=await reveal(f,a.id);assert.equal(wrong.status,503);assert.equal(wrong.data.error,'token_decryption_failed');
      f.env.TOKEN_ENCRYPTION_KEY=key;
      f.db.prepare('UPDATE access_tokens SET token_ciphertext=? WHERE id=?').run(box,b.id);
      assert.equal((await reveal(f,b.id)).data.error,'token_decryption_failed');
      f.db.prepare('UPDATE access_tokens SET token_ciphertext=? WHERE id=?').run(box.slice(0,-1)+(box.endsWith('0')?'1':'0'),a.id);
      assert.equal((await reveal(f,a.id)).data.error,'token_decryption_failed');
      assert.equal((await api(f.env,'/api/me','GET',null,a.token)).status,200);
      for(const value of [a.token,b.token,box,key])assert.ok(!logs.join('\n').includes(value));
    }finally{console.error=oldError;}
  }finally{f.close();}
});

test('hash-only old tokens remain valid and explicitly report an unavailable value, without reissuance',async()=>{
  const f=await ready();try{
    const old=await legacyToken(f.env,'Old token','client',[]);
    const list=await web(f,'/api/tokens');assert.equal(list.data.tokens.find(t=>t.id===old.id).recoverable,false);
    const r=await reveal(f,old.id);assert.equal(r.status,409);assert.equal(r.data.error,'token_value_unavailable');
    assert.equal((await api(f.env,'/api/me','GET',null,old.token)).status,200);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE credential_type='api'").get().n,1);
  }finally{f.close();}
});

test('viewing revoked or expired tokens does not revive, replace, extend or expand their access',async()=>{
  const f=await ready();try{
    const a=await mint(f),b=await mint(f,'all_writer',30);
    await web(f,`/api/tokens/${a.id}/revoke`,'POST',{});
    f.db.prepare("UPDATE access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.id);
    const revoked=await reveal(f,a.id),expired=await reveal(f,b.id);
    assert.equal(revoked.data.token,a.token);assert.ok(revoked.data.revokedAt);assert.equal(revoked.data.active,false);
    assert.equal(expired.data.token,b.token);assert.equal(expired.data.active,false);assert.equal(expired.data.expiresAt,'2000-01-01T00:00:00.000Z');
    for(const t of [a,b])assert.equal((await api(f.env,'/api/me','GET',null,t.token)).status,401);
  }finally{f.close();}
});
