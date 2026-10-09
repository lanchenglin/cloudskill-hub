import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture,skill,api,setup} from './helpers.mjs';
import { encode64 } from '../src/core.js';
import { parseAgents, targetFor, hubOrigin, install, check, sync, subscribe, saveConfig, loadState, fingerprint } from '../cli/manager.mjs';
import {handler} from '../src/index.js';

test('CLI installs across Claude Code, Codex and Hermes; detects modifications and backups',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cloudskill-test-'));const oldHome=process.env.CLOUDSKILL_HOME,oldConf=process.env.CLOUDSKILL_CONFIG_DIR,oldFetch=globalThis.fetch;
  process.env.CLOUDSKILL_HOME=home;process.env.CLOUDSKILL_CONFIG_DIR=path.join(home,'config');
  const {env,close}=fixture();
  try{
    const admin=await setup(env);
    await api(env,'/api/projects','POST',{slug:'devops',title:'DevOps'},admin);
    await api(env,'/api/projects/devops/skills/example','POST',{files:skill('example')},admin);
    const config=await saveConfig({url:'https://hub.example',token:admin,device:'test-device'});
    globalThis.fetch=(url,init={})=>handler(new Request(url,init),env);
    assert.deepEqual(parseAgents('claude,codex,hermes'),['claude','codex','hermes']);
    assert.throws(()=>hubOrigin('http://not-local.invalid'));
    const first=await install(config,'devops','example',['claude','codex','hermes']);
    assert.equal(first.length,3);assert.equal(first.filter(x=>x.status==='installed').length,3);
    for(const agent of ['claude','codex','hermes']){const folder=targetFor('example',agent);assert.match(await fs.readFile(path.join(folder,'SKILL.md'),'utf8'),/name: example/);}
    const stat=await loadState();assert.equal(Object.keys(stat.installed).length,3);
    const same=await install(config,'devops','example',['hermes']);assert.equal(same[0].status,'current');
    const local=targetFor('example','hermes');await fs.appendFile(path.join(local,'SKILL.md'),'\nlocal edit');
    await assert.rejects(install(config,'devops','example',['hermes']),/local modifications/);
    const change={...skill('example'),'references/change.md':encode64(new TextEncoder().encode('new'))};
    await api(env,'/api/projects/devops/skills/example','POST',{files:change},admin);
    const checkRows=await check(config);assert.equal(checkRows.filter(r=>r.newVersion).length,3);assert.equal(checkRows.filter(r=>r.modified).length,1);
    await assert.rejects(install(config,'devops','example',['hermes']),/local modifications/);
    const recovered=await install(config,'devops','example',['hermes'],{force:true});assert.equal(recovered[0].status,'updated');
    assert.ok(recovered[0].backup);assert.match(await fs.readFile(path.join(recovered[0].backup,'SKILL.md'),'utf8'),/local edit/);
    await subscribe(config,'devops',['claude','codex'],['*']);
    const synced=await sync(config);assert.equal(synced.length,2);assert.equal((await api(env,'/api/devices','GET',null,admin)).data.devices.length,1);
    assert.ok((await fingerprint(local)).length===64);
  }finally{
    close();globalThis.fetch=oldFetch;
    if(oldHome===undefined)delete process.env.CLOUDSKILL_HOME;else process.env.CLOUDSKILL_HOME=oldHome;
    if(oldConf===undefined)delete process.env.CLOUDSKILL_CONFIG_DIR;else process.env.CLOUDSKILL_CONFIG_DIR=oldConf;
    await fs.rm(home,{recursive:true,force:true});
  }
});
