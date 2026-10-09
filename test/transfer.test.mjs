import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {saveConfig,install,sync,subscribe,targetFor,loadState,installBundle} from '../cli/manager.mjs';
import {publishSource,uploadSources} from '../cli/transfer.mjs';
import {pack} from '../public/lib/archive.js';
import {DEFAULT_LIMITS} from '../public/lib/policy.js';

test('CLI folder and ZIP publishing, 7 MiB installation to all agents, no-op, updates, integrity and ownership',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-transfer-')),f=fixture(),oldFetch=globalThis.fetch;
  const envBackup={...process.env};process.env.CLOUDSKILL_HOME=dir;process.env.CLOUDSKILL_CONFIG_DIR=path.join(dir,'config');
  try{
    const t=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'devops',title:'DevOps'},t);
    globalThis.fetch=(u,o={})=>handler(new Request(u,o),f.env);
    const config=await saveConfig({url:'https://hub.example',token:t,device:'transfer-test'});
    const source=path.join(dir,'source');await fs.mkdir(path.join(source,'assets'),{recursive:true});
    await fs.writeFile(path.join(source,'SKILL.md'),Buffer.from(skill('big-cli')['SKILL.md'],'base64'));
    const data=randomBytes(7*1024*1024);await fs.writeFile(path.join(source,'assets','sample.bin'),data);
    const first=await publishSource(config,'devops',source);assert.equal(first.version,1);
    const installed=await install(config,'devops','big-cli',['claude','codex','hermes']);assert.equal(installed.length,3);
    for(const agent of ['claude','codex','hermes'])assert.deepEqual(await fs.readFile(path.join(targetFor('big-cli',agent),'assets','sample.bin')),data);
    assert.equal((await publishSource(config,'devops',source)).unchanged,true);
    await fs.appendFile(path.join(source,'SKILL.md'),'\nUpdated.\n');
    const zip=await pack(await uploadSources(source,DEFAULT_LIMITS));const zipPath=path.join(dir,'skill.zip');await fs.writeFile(zipPath,new Uint8Array(await zip.blob.arrayBuffer()));
    const next=await publishSource(config,'devops',zipPath);assert.equal(next.version,2);
    await fs.appendFile(path.join(targetFor('big-cli','hermes'),'SKILL.md'),'\nLocal note.');
    await assert.rejects(install(config,'devops','big-cli',['hermes']),/local modifications/);
    const updated=await install(config,'devops','big-cli',['hermes'],{force:true});assert.ok(updated[0].backup);
    assert.ok(!updated[0].backup.startsWith(path.join(dir,'.hermes','skills')));
    await subscribe(config,'devops',['claude','codex'],['big-cli']);await sync(config);
    assert.equal(Object.keys((await loadState()).installed).length,3);
    const rec=f.db.prepare('SELECT archive_key FROM skill_versions WHERE version=2').get();const corrupt=Buffer.from(f.env.BUCKET.objects.get(rec.archive_key));corrupt[60]^=1;f.env.BUCKET.objects.set(rec.archive_key,corrupt);
    await assert.rejects(install(config,'devops','big-cli',['claude']),/SHA-256 mismatch/);
    assert.match(await fs.readFile(path.join(targetFor('big-cli','claude'),'SKILL.md'),'utf8'),/Updated/);
  }finally{globalThis.fetch=oldFetch;for(const k of ['CLOUDSKILL_HOME','CLOUDSKILL_CONFIG_DIR']){if(envBackup[k]===undefined)delete process.env[k];else process.env[k]=envBackup[k];}f.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('CLI recovers a lost finalize response and can resume an already-uploaded package',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-resume-')),f=fixture(),oldFetch=globalThis.fetch;
  try{
    const t=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'devops',title:'DevOps'},t);
    const source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'SKILL.md'),Buffer.from(skill('resumable')['SKILL.md'],'base64'));
    const config={url:'https://hub.example',token:t};let drop=true;
    globalThis.fetch=async(u,o={})=>{const r=await handler(new Request(u,o),f.env);if(u.endsWith('/finalize')&&drop){drop=false;throw Error('Connection lost after commit');}return r;};
    let id;const done=await publishSource(config,'devops',source,{onProgress:e=>{if(e.phase==='session')id=e.id;}});assert.equal(done.version,1);
    const again=await publishSource(config,'devops',source,{resume:id});assert.equal(again.version,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get().n,1);
    await fs.appendFile(path.join(source,'SKILL.md'),'Changed');await assert.rejects(publishSource(config,'devops',source,{resume:id}),/does not match/);
  }finally{globalThis.fetch=oldFetch;f.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('failed first install state persistence does not leave an untracked skill directory',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-rollback-')),oldHome=process.env.CLOUDSKILL_HOME,oldConf=process.env.CLOUDSKILL_CONFIG_DIR;
  process.env.CLOUDSKILL_HOME=dir;process.env.CLOUDSKILL_CONFIG_DIR=path.join(dir,'config');
  try{
    await fs.mkdir(path.join(dir,'config','state.json'),{recursive:true});
    const bundle={slug:'rollback-check',project:'devops',version:1,files:skill('rollback-check')};
    const {fileDigest}=await import('../src/core.js');bundle.digest=await fileDigest(bundle.files);
    await assert.rejects(installBundle(bundle,'devops','hermes',{state:{version:1,installed:{}}}));
    await assert.rejects(fs.stat(targetFor('rollback-check','hermes')),/ENOENT/);
  }finally{if(oldHome===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=oldHome;if(oldConf===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=oldConf;await fs.rm(dir,{recursive:true,force:true});}
});
