import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {saveConfig,loadConfig,install,subscribe,sync,targetFor,request,heartbeat} from '../cli/manager.mjs';
import {publishSource} from '../cli/transfer.mjs';
import {connectionHeaders,connectionPath} from '../cli/connection.mjs';

test('explicit public connection installs and updates shared ZIPs with no credentials and no heartbeat',async()=>{
  const f=fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'csh-public-cli-')),oldFetch=globalThis.fetch;
  const saved={CLOUDSKILL_HOME:process.env.CLOUDSKILL_HOME,CLOUDSKILL_CONFIG_DIR:process.env.CLOUDSKILL_CONFIG_DIR};
  process.env.CLOUDSKILL_HOME=path.join(temp,'home');process.env.CLOUDSKILL_CONFIG_DIR=path.join(temp,'config');
  try{
    const admin=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'collection',title:'Collection'},admin);
    const writer=(await api(f.env,'/api/tokens','POST',{label:'Shared writer',role:'shared_writer',expiresInDays:null},admin)).data.token;
    globalThis.fetch=(url,init={})=>handler(new Request(url,init),f.env);
    const folder=path.join(temp,'source');await fs.mkdir(folder);
    await fs.writeFile(path.join(folder,'SKILL.md'),'---\nname: public-cli\ndescription: Public CLI fixture.\n---\nVersion one.\n');
    await publishSource({url:'https://hub.example',token:writer},'collection',folder,{visibility:'public'});
    await api(f.env,'/api/projects/collection/skills/private-cli','POST',{files:skill('private-cli')},admin);
    const calls=[];
    globalThis.fetch=(url,init={})=>{calls.push({url,headers:new Headers(init.headers),method:init.method||'GET'});return handler(new Request(url,init),f.env);};
    const publicConfig=await saveConfig({url:'https://hub.example',token:null,device:'public-fixture'});
    assert.equal((await loadConfig()).token,null);
    assert.equal((await request(publicConfig,'GET','/api/me')).role,'guest');
    assert.equal((await install(publicConfig,'collection','public-cli',['hermes']))[0].status,'installed');
    await assert.rejects(install(publicConfig,'collection','private-cli',['hermes']),/not found or not authorized/);
    await subscribe(publicConfig,'collection',['hermes'],['*']);await sync(publicConfig);
    assert.equal((await heartbeat(publicConfig)).reported,false);
    for(const c of calls){assert.ok(new URL(c.url).pathname.startsWith('/api/public/'));assert.equal(c.headers.has('authorization'),false);assert.equal(c.headers.has('cookie'),false);assert.equal(c.method,'GET');}
    globalThis.fetch=(url,init={})=>handler(new Request(url,init),f.env);
    await fs.appendFile(path.join(folder,'SKILL.md'),'Version two.\n');await publishSource({url:'https://hub.example',token:writer},'collection',folder);
    const updated=await sync(publicConfig);assert.equal(updated[0].status,'updated');
    assert.match(await fs.readFile(path.join(targetFor('public-cli','hermes'),'SKILL.md'),'utf8'),/Version two/);
    await assert.rejects(publishSource(publicConfig,'collection',folder),/cannot publish/);
    await assert.rejects(request(publicConfig,'POST','/api/projects',{}),/write token/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n,0);
    const invalid={...publicConfig,token:'invalid'};await assert.rejects(request(invalid,'GET','/api/catalog'),/Invalid CloudSkill API token/);
  }finally{
    globalThis.fetch=oldFetch;f.close();for(const [k,v] of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;await fs.rm(temp,{recursive:true,force:true});
  }
});

test('public transport is an allowlist; missing/invalid credentials are not treated as anonymous',()=>{
  assert.deepEqual(connectionHeaders({token:null}),{});
  for(const token of [undefined,'',false,'bad'])assert.throws(()=>connectionHeaders({token}),/Invalid/);
  assert.equal(connectionPath({token:null},'/api/projects/a/skills/b/versions/1?format=manifest'),'/api/public/projects/a/skills/b/versions/1?format=manifest');
  for(const route of ['/api/tokens','/api/uploads','/api/auth/session','/api/projects/a/skills/b/rollback','https://evil.invalid/api/catalog','//evil.invalid'])assert.throws(()=>connectionPath({token:null},route));
});

test('actual CLI connect/list/install/update run noninteractively without a token, ignoring unrelated token environment',async()=>{
  const f=fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'csh-public-command-'));
  const admin=await setup(f.env);await api(f.env,'/api/projects','POST',{slug:'collection',title:'Collection'},admin);
  await api(f.env,'/api/projects/collection/skills/cli-command','POST',{files:skill('cli-command'),visibility:'public'},admin);
  await api(f.env,'/api/projects/collection/skills/cli-private','POST',{files:skill('cli-private'),visibility:'private'},admin);
  const allToken=(await api(f.env,'/api/tokens','POST',{label:'Previous private connection',role:'all_writer'},admin)).data.token;
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    try{calls.push({url:req.url,authorization:req.headers.authorization});const response=await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half'}),f.env);res.writeHead(response.status,Object.fromEntries(response.headers));Readable.fromWeb(response.body).pipe(res);}catch{res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const env={...process.env,CLOUDSKILL_HOME:path.join(temp,'home'),CLOUDSKILL_CONFIG_DIR:path.join(temp,'config'),CLOUDSKILL_TOKEN:'must-not-be-used-for-public'};
  for(const key of ['HERMES_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME'])delete env[key];
  async function cli(...args){
    const child=spawn(process.execPath,['cli/cloudskill.mjs',...args],{cwd:new URL('../',import.meta.url),env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.equal(code,0,err);return out;
  }
  try{
    env.CLOUDSKILL_TOKEN=allToken;await cli('login',url);await cli('install','collection/cli-private','--agents','hermes');
    env.CLOUDSKILL_TOKEN='must-not-be-used-for-public';calls.length=0;
    assert.match(await cli('connect',url),/guest/);assert.match(await cli('list'),/cli-command/);
    assert.match(await cli('install','collection/cli-command','--agents','hermes'),/installed/);
    await api(f.env,'/api/projects/collection/skills/cli-command','POST',{files:skill('cli-command',{'updated.txt':Buffer.from('changed').toString('base64')}),visibility:'public'},admin);
    const output=await cli('update');assert.match(output,/updated/);assert.match(output,/not readable/);
    assert.match(await fs.readFile(path.join(temp,'home','.hermes','skills','cli-private','SKILL.md'),'utf8'),/cli-private/);
    assert.equal(await fs.readFile(path.join(temp,'home','.hermes','skills','cli-command','updated.txt'),'utf8'),'changed');
    assert.ok(calls.length>0);assert.ok(calls.every(c=>!c.authorization&&c.url.startsWith('/api/public/')));
  }finally{await new Promise(resolve=>server.close(resolve));f.close();await fs.rm(temp,{recursive:true,force:true});}
});
