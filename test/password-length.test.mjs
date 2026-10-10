import test from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync,randomBytes} from 'node:crypto';
import {fixture} from './helpers.mjs';
import {handler} from '../src/index.js';
import {validatePassword,hashPassword,hashInitialPassword,verifyPassword,INITIAL_ADMIN_PASSWORD,PASSWORD_PROFILE} from '../src/password.js';
import {recoverySql} from '../scripts/reset-password.mjs';

async function web(env,route,body,session){
  const response=await handler(new Request('https://hub.example'+route,{method:body===undefined?'GET':'POST',
    headers:{Origin:'https://hub.example','X-CloudSkill-Request':'1',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.data.csrfToken}:{})},
    body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function initial(f){
  assert.equal((await web(f.env,'/api/auth/setup',{secret:f.env.BOOTSTRAP_SECRET})).status,201);
  const s=await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD});
  assert.equal(s.data.mustChangePassword,true);return s;
}

test('password length is 6–20 Unicode code points, inclusive, without trimming or truncation',async()=>{
  for(const value of ['abcdef','x'.repeat(20),'中文密码测试','🔑'.repeat(20),' 1234 ',INITIAL_ADMIN_PASSWORD])
    assert.equal(validatePassword(value),value);
  for(const value of ['', 'a'.repeat(5),'x'.repeat(21),'🔑'.repeat(5),'🔑'.repeat(21),null,0,{},['abcdef']])
    assert.throws(()=>validatePassword(value),/6–20/);
  const secret=' 🔑中文abc ';const hashed=await hashPassword(secret);
  assert.equal(await verifyPassword(secret,hashed),true);
  assert.equal(await verifyPassword(secret.trim(),hashed),false);
  assert.equal(await verifyPassword(secret+'x',hashed),false);
  await assert.rejects(hashPassword('x'.repeat(21)),/6–20/);
});

test('HTTP setup and mandatory/normal password changes enforce 5/6/20/21 boundaries',async()=>{
  const f=fixture();try{
    for(const password of ['abcde','x'.repeat(21)]){
      const result=await web(f.env,'/api/auth/setup',{secret:f.env.BOOTSTRAP_SECRET,password});
      assert.equal(result.status,400);assert.match(result.data.error,/6–20/);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get().n,0);
    }
    const s=await initial(f);
    for(const newPassword of ['abcde','x'.repeat(21)]){
      const r=await web(f.env,'/api/auth/password',{currentPassword:INITIAL_ADMIN_PASSWORD,newPassword},s);
      assert.equal(r.status,400);assert.match(r.data.error,/6–20/);
    }
    assert.equal(f.db.prepare('SELECT must_change_password FROM web_admin').get().must_change_password,1);
    assert.equal((await web(f.env,'/api/auth/password',{currentPassword:INITIAL_ADMIN_PASSWORD,newPassword:'short6'},s)).status,200);
    assert.equal((await web(f.env,'/api/auth/session',undefined,s)).status,401);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:INITIAL_ADMIN_PASSWORD})).status,401);
    const active=await web(f.env,'/api/auth/login',{username:'admin',password:'short6'});
    assert.equal(active.status,200);assert.equal(active.data.mustChangePassword,false);
    assert.equal((await web(f.env,'/api/auth/password',{currentPassword:'short6',newPassword:'short6'},active)).status,400);
    const value='🔑'.repeat(20);
    assert.equal((await web(f.env,'/api/auth/password',{currentPassword:'short6',newPassword:value},active)).status,200);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:value})).status,200);
  }finally{f.close();}
});

test('trusted recovery uses the same 6–20 policy and cannot restore the public initial password',async()=>{
  const f=fixture();try{
    const s=await initial(f);
    await assert.rejects(hashPassword('abcde'),/6–20/);
    await assert.rejects(hashPassword('x'.repeat(21)),/6–20/);
    await assert.rejects(hashPassword(INITIAL_ADMIN_PASSWORD),/initial password/);
    assert.equal(await verifyPassword(INITIAL_ADMIN_PASSWORD,await hashInitialPassword()),true);
    const value='reset6',hash=await hashPassword(value);
    f.db.exec(recoverySql({hash,version:1}));
    assert.equal((await web(f.env,'/api/auth/session',undefined,s)).status,401);
    const login=await web(f.env,'/api/auth/login',{username:'admin',password:value});
    assert.equal(login.status,200);assert.equal(login.data.mustChangePassword,false);
  }finally{f.close();}
});

test('existing longer passwords still authenticate; replacement passwords use the new length',async()=>{
  const f=fixture();try{
    await initial(f);
    // Model a pre-existing account without changing or migrating real user data.
    const old='An existing long account password from the prior policy';
    const salt=randomBytes(16);const key=scryptSync(old,salt,32,PASSWORD_PROFILE);
    const hash=`scrypt$16384$8$5$${salt.toString('hex')}$${key.toString('hex')}`;
    f.db.prepare('UPDATE web_admin SET password_hash=?,must_change_password=0').run(hash);
    const s=await web(f.env,'/api/auth/login',{username:'admin',password:old});
    assert.equal(s.status,200);
    assert.equal((await web(f.env,'/api/auth/reauth',{password:old},s)).status,200);
    assert.equal((await web(f.env,'/api/auth/password',{currentPassword:old,newPassword:'new123'},s)).status,200);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:old})).status,401);
    assert.equal((await web(f.env,'/api/auth/login',{username:'admin',password:'new123'})).status,200);
  }finally{f.close();}
});
