import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {prepareTokenKey} from '../scripts/prepare-token-key.mjs';
import {sealToken,openToken} from '../src/token-vault.js';
import {randomId,tokenHash} from '../src/core.js';
const root=fileURLToPath(new URL('../',import.meta.url));

test('AES-GCM uses a fresh IV for repeated values and authenticates id and digest',async()=>{
  const env={TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')},id=randomId('t_'),token=randomId('csh_'),digest=await tokenHash(token);
  const first=await sealToken(env,id,digest,token),second=await sealToken(env,id,digest,token);
  assert.notEqual(first,second);assert.notEqual(first.split(':')[1],second.split(':')[1]);
  assert.equal(await openToken(env,id,digest,first),token);
  await assert.rejects(openToken(env,randomId('t_'),digest,first),/token_decryption_failed/);
  await assert.rejects(openToken(env,id,'0'.repeat(64),first),/token_decryption_failed/);
  await assert.rejects(openToken(env,id,digest,'v2:'+first.slice(3)),/token_decryption_failed/);
});

test('prepare key creates/reuses a private file without logging or overwriting its value',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-key-test-'));await fs.chmod(dir,0o700);
  try{
    const one=await prepareTokenKey(dir);assert.equal(one.created,true);
    const original=await fs.readFile(one.path,'utf8'),value=JSON.parse(original).TOKEN_ENCRYPTION_KEY;
    assert.match(value,/^[a-f0-9]{64}$/);
    if(process.platform!=='win32')assert.equal((await fs.stat(one.path)).mode&0o777,0o600);
    const two=await prepareTokenKey(dir);assert.equal(two.created,false);assert.equal(await fs.readFile(two.path,'utf8'),original);
    const result=spawnSync(process.execPath,['scripts/prepare-token-key.mjs','--credentials-dir',dir],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Reusing/);
    assert.ok(!result.stdout.includes(value));assert.ok(!result.stderr.includes(value));
    await fs.writeFile(one.path,'bad content',{mode:0o600});
    await assert.rejects(prepareTokenKey(dir),/not overwritten/);
    assert.equal(await fs.readFile(one.path,'utf8'),'bad content');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('prepare key refuses paths inside Git and unsafe permissions without creating a new key',async()=>{
  await assert.rejects(prepareTokenKey(root),/outside/);
  await assert.rejects(prepareTokenKey(''),/Specify/);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-key-permission-'));
  try{
    if(process.platform!=='win32'){
      await fs.chmod(dir,0o755);await assert.rejects(prepareTokenKey(dir),/private/);
      await assert.rejects(fs.access(path.join(dir,'token-encryption.json')),{code:'ENOENT'});
      await fs.chmod(dir,0o700);
      const link=path.join(dir,'link');await fs.symlink(root,link,'dir');
      await assert.rejects(prepareTokenKey(link),/symlink/);
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('recoverable-token migration preserves old hashes, expiry, revocation and roles verbatim',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const migrations=(await fs.readdir(path.join(root,'migrations'))).filter(f=>f.endsWith('.sql')).sort();
    for(const file of migrations.filter(f=>f!=='0006_recoverable_tokens.sql'))db.exec(await fs.readFile(path.join(root,'migrations',file),'utf8'));
    db.prepare("INSERT INTO access_tokens(id,label,token_hash,role,project_scope,created_at,revoked_at,expires_at,can_publish,permission_mode) VALUES('old','Old','hash','client','[]','2026-01-01','2026-02-01',NULL,1,'shared')").run();
    const before=db.prepare('SELECT * FROM access_tokens').get();
    db.exec(await fs.readFile(path.join(root,'migrations/0006_recoverable_tokens.sql'),'utf8'));
    const after=db.prepare('SELECT * FROM access_tokens').get();
    assert.equal(after.token_ciphertext,null);delete after.token_ciphertext;
    assert.deepEqual(after,before);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
