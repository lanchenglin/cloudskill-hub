import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fixture, api, setup, skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {putVerified} from '../src/upload-stream.js';
import {fileDigest} from '../src/core.js';
import {pack, boundedBytes} from '../public/lib/archive.js';
import {HARD_LIMITS, DEFAULT_LIMITS} from '../public/lib/policy.js';
import {publishBrowser} from '../public/lib/browser-upload.js';
import {downloadPackage, publishSource} from '../cli/transfer.mjs';
import {installBundle, targetFor, loadState, saveConfig, install, subscribe, sync} from '../cli/manager.mjs';

const contents = '---\nname: resume-safe\ndescription: Safe upload recovery.\n---\n# Skill\n';
const sources = () => [{name:'SKILL.md', blob:new Blob([contents])}];
const config = {url:'https://hub.example', token:'csh_'+'a'.repeat(48)};
const downloadPath = '/api/projects/devops/skills/resume-safe/versions/1/download';

test('download rejects untrusted size, digest and file metadata before issuing HTTP', async () => {
  const pkg = await pack(sources()), oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(pkg.blob); };
  try {
    for (const size of [undefined, null, '100', -1, 0, 21, NaN, Infinity, HARD_LIMITS.maxArchiveBytes+1]) {
      await assert.rejects(downloadPackage(config, {downloadPath, digest:pkg.manifest.archiveDigest, manifest:{...pkg.manifest, archiveBytes:size}}));
    }
    for (const patch of [
      {archiveBytes:pkg.manifest.archiveBytes+1}, {archiveDigest:'invalid'},
      {files:[]}, {files:[{...pkg.manifest.files[0], name:'../SKILL.md'}]},
      {files:[{...pkg.manifest.files[0], size:HARD_LIMITS.maxFileBytes+1}]},
    ]) {
      const manifest = {...pkg.manifest, ...patch};
      await assert.rejects(downloadPackage(config, {downloadPath, digest:manifest.archiveDigest, manifest}));
    }
    assert.equal(requests, 0, 'invalid metadata must not start an unbounded download');
    const entries = await downloadPackage(config, {downloadPath, digest:pkg.manifest.archiveDigest, manifest:pkg.manifest});
    assert.equal(requests, 1);
    assert.equal(await entries[0].blob.text(), contents);
  } finally { globalThis.fetch = oldFetch; }
});

test('bounded stream reader fails closed when caller supplies no valid byte bound', async () => {
  for (const max of [undefined, null, NaN, Infinity, -1, '10', 1.5]) {
    await assert.rejects(boundedBytes(new Blob(['small']).stream(), max));
  }
  assert.equal((await boundedBytes(new Blob([]).stream(), 0)).length, 0);
  await assert.rejects(boundedBytes(new Blob(['x']).stream(), 0));
});

async function readyPublicSession(f, token, pkg) {
  const started = await api(f.env, '/api/projects/devops/skills/resume-safe/uploads', 'POST', {...pkg.manifest, visibility:'public'}, token);
  assert.equal(started.status, 201);
  const id = started.data.id;
  const reply = await handler(new Request(config.url+`/api/uploads/${id}/archive`, {
    method:'PUT', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/zip'}, body:pkg.blob,
  }), f.env);
  assert.equal(reply.status, 200, await reply.text());
  return id;
}

test('CLI resume refuses a public session when --private was explicitly requested', async () => {
  const f = fixture(), oldFetch = globalThis.fetch, dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csh-private-resume-'));
  try {
    const token = await setup(f.env);
    await api(f.env, '/api/projects', 'POST', {slug:'devops', title:'DevOps'}, token);
    const pkg = await pack(sources()), id = await readyPublicSession(f, token, pkg);
    await fs.writeFile(path.join(dir,'SKILL.md'), contents);
    globalThis.fetch = (u,o={}) => handler(new Request(u,o),f.env);
    await assert.rejects(publishSource({...config,token}, 'devops', dir, {resume:id, visibility:'private'}), /visibility/i);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get().n, 0);
    assert.equal((await api(f.env, `/api/uploads/${id}`, 'GET', null, token)).data.visibility, 'public');
    const result = await publishSource({...config,token}, 'devops', dir, {resume:id, visibility:'public'});
    assert.equal(result.version, 1);
  } finally { globalThis.fetch = oldFetch; f.close(); await fs.rm(dir,{recursive:true,force:true}); }
});

test('browser checks server-owned visibility rather than trusting cached pending metadata', async () => {
  const f = fixture();
  try {
    const token = await setup(f.env);
    await api(f.env, '/api/projects', 'POST', {slug:'devops', title:'DevOps'}, token);
    const pkg = await pack(sources()), id = await readyPublicSession(f, token, pkg);
    const call = async (p,m='GET',b) => {
      const r = await api(f.env,p,m,b,token);
      if (r.status >= 400) throw Object.assign(Error(r.data.error),{status:r.status});
      return r.data;
    };
    await assert.rejects(publishBrowser({entries:sources(),limits:DEFAULT_LIMITS,project:'devops',visibility:'private',baseVersion:0,api:call,token,
      pending:{id,project:'devops',slug:'resume-safe',digest:pkg.manifest.archiveDigest,visibility:'private'},
    }), /visibility|可见性|公开权限/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get().n, 0);
    assert.equal(f.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id).state, 'ready');
  } finally { f.close(); }
});

test('R2 early failure cancels every upload pipe for synchronous and asynchronous errors', {timeout:5000}, async () => {
  const pkg = await pack(sources());
  for (const asynchronous of [false,true]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array([0x50])); },
      cancel() { cancelled = true; },
    });
    const request = new Request(config.url, {method:'PUT', headers:{'Content-Type':'application/zip'}, body:stream, duplex:'half'});
    const storage = {put(){if(asynchronous)return Promise.reject(Error('storage unavailable'));throw Error('storage unavailable');}};
    await assert.rejects(putVerified(request, storage, 'test.zip', pkg.manifest, DEFAULT_LIMITS, 'resume-safe'), /storage unavailable/);
    assert.equal(cancelled, true, 'storage failure must release the source stream before returning');
    assert.equal(request.body.locked, false, 'all upstream pipes must have settled');
  }
});

test('--force really restores a deleted managed skill even when the cloud digest is unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'csh-restore-'));
  const backup = {home:process.env.CLOUDSKILL_HOME, config:process.env.CLOUDSKILL_CONFIG_DIR};
  process.env.CLOUDSKILL_HOME=dir;process.env.CLOUDSKILL_CONFIG_DIR=path.join(dir,'config');
  try {
    const files=skill('restore-me'), bundle={slug:'restore-me',project:'devops',version:1,format:1,files,digest:await fileDigest(files)};
    await installBundle(bundle,'devops','hermes');
    await fs.rm(targetFor('restore-me','hermes'),{recursive:true});
    await assert.rejects(installBundle(bundle,'devops','hermes'), /removed externally/);
    await installBundle(bundle,'devops','hermes',{force:true});
    assert.match(await fs.readFile(path.join(targetFor('restore-me','hermes'),'SKILL.md'),'utf8'),/restore-me/);
    assert.equal(Object.keys((await loadState()).installed).length,1);
    const metadataOnly=await installBundle({...bundle,version:2},'devops','hermes');
    assert.equal(metadataOnly.status,'current');
    assert.equal((await loadState()).installed['devops/restore-me#hermes'].version,2);
  } finally {
    if(backup.home===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=backup.home;
    if(backup.config===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=backup.config;
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('repeated sync skips unchanged ZIP downloads but still detects local edits', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'csh-no-redownload-')), f=fixture(), oldFetch=globalThis.fetch;
  const backup={home:process.env.CLOUDSKILL_HOME,config:process.env.CLOUDSKILL_CONFIG_DIR};
  process.env.CLOUDSKILL_HOME=dir;process.env.CLOUDSKILL_CONFIG_DIR=path.join(dir,'config');
  try {
    const token=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'devops',title:'DevOps'},token);
    const pkg=await pack(sources()),id=await readyPublicSession(f,token,pkg);
    await api(f.env,`/api/uploads/${id}/finalize`,'POST',{},token);
    let downloads=0;
    globalThis.fetch=(u,o={})=>{if(new URL(u).pathname.endsWith('/download'))downloads++;return handler(new Request(u,o),f.env);};
    const c=await saveConfig({...config,token,device:'sync-review'});
    await subscribe(c,'devops',['claude','codex','hermes'],['resume-safe']);
    const preview=await sync(c,{dryRun:true});
    assert.ok(preview.every(r=>r.status==='install'));assert.equal(downloads,0,'preview does not fetch ZIP bytes');
    assert.equal(Object.keys((await loadState()).installed).length,0);
    await assert.rejects(fs.stat(targetFor('resume-safe','hermes')),/ENOENT/);
    await sync(c);assert.equal(downloads,1,'one ZIP download can serve three agents');
    const again=await sync(c);assert.equal(downloads,1,'unchanged sync must not download the entire archive');
    assert.ok(again.every(r=>r.status==='current'));
    await fs.appendFile(path.join(targetFor('resume-safe','hermes'),'SKILL.md'),'\nLocal edits');
    await assert.rejects(sync(c),/local modifications/);
    await sync(c,{force:true});assert.equal(downloads,2);
    // An explicit install retains full remote integrity verification.
    await install(c,'devops','resume-safe',['claude']);assert.equal(downloads,3);
  } finally {
    globalThis.fetch=oldFetch;f.close();
    if(backup.home===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=backup.home;
    if(backup.config===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=backup.config;
    await fs.rm(dir,{recursive:true,force:true});
  }
});
