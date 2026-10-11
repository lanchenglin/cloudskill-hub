import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {buildUsageGuide,guideOrigin,usageMarkdown,shellQuote,clientSetup} from '../public/lib/usage-guide.js';
import {fixture,api,setup,skill} from './helpers.mjs';
import {handler} from '../src/index.js';
import {encode64} from '../src/core.js';
const defaults={origin:'https://hub.example',project:'personal',skill:'example'};
const root=fileURLToPath(new URL('../',import.meta.url));

test('install instructions bind the real Hub and one explicit agent, never default to all agents',()=>{
  for(const agent of ['hermes','claude','codex']){
    const r=buildUsageGuide({...defaults,agent});assert.match(r.prompt,/https:\/\/hub\.example\/usage\.md/);
    assert.ok(r.commands.includes("cloudskill connect 'https://hub.example'"));
    assert.ok(r.commands.includes(`cloudskill install 'personal/example' --agents ${agent} --dry-run`));
    assert.ok(r.commands.endsWith(`cloudskill install 'personal/example' --agents ${agent}`));
    assert.ok(!r.commands.includes('login'));assert.ok(!r.commands.includes('--force'));
  }
});
test('private install requests an existing all-writer token without embedding secrets or website credentials',()=>{
  const r=buildUsageGuide({...defaults,access:'private',token:'do-not-include-me',password:'do-not-include-password'});
  assert.match(r.commands,/cloudskill login/);assert.match(r.prompt,/修改全部技能/);assert.match(r.prompt,/CLOUDSKILL_TOKEN/);
  assert.match(r.prompt,/不要让我把真实 Token 发到聊天/);assert.ok(!r.prompt.includes('do-not-include'));
  assert.ok(!r.commands.includes('export '));assert.ok(!r.commands.includes('$env:'));
});
test('missing names result only in discovery, never guessed or placeholder installs',()=>{
  for(const fields of [{project:'',skill:''},{project:'personal',skill:''},{project:'',skill:'example'}]){
    const r=buildUsageGuide({...defaults,...fields});assert.equal(r.incomplete,true);assert.ok(!r.commands.includes('cloudskill install'));
    assert.match(r.prompt,/未选定前不要安装/);
  }
});
test('subscriptions quote the wildcard and explain all-subscription scope and replacement',()=>{
  const r=buildUsageGuide({...defaults,task:'subscribe',agent:'claude',access:'private'});
  assert.match(r.commands,/subscribe 'personal' --agents claude --skills '\*'/);
  assert.match(r.commands,/sync --dry-run\ncloudskill sync/);assert.match(r.prompt,/替换/);assert.match(r.prompt,/其他已订阅分类/);
  assert.ok(!r.commands.includes('install'));assert.ok(!r.commands.includes('personal/example'));
});
test('update follows installed records, has no invented --agents filter, and does not subscribe',()=>{
  const r=buildUsageGuide({...defaults,task:'update',agent:'hermes'});
  assert.match(r.commands,/cloudskill check\ncloudskill update --dry-run\ncloudskill update/);
  assert.ok(!r.commands.includes('--agents'));assert.ok(!r.commands.includes('subscribe'));assert.match(r.prompt,/所有工具/);
});
test('publish requires a source, preserves explicit visibility, and safely quotes shell arguments',()=>{
  assert.ok(!buildUsageGuide({...defaults,task:'publish'}).commands.includes('cloudskill publish'));
  for(const shell of ['bash','powershell']){
    const source="./owner's skill.zip",r=buildUsageGuide({...defaults,task:'publish',source,shell,access:'private'});
    assert.ok(r.commands.includes(`cloudskill publish 'personal' ${shellQuote(source,shell)} --private`));
    assert.match(r.prompt,/不是向 GitHub 提交技能/);assert.ok(!r.commands.includes('--public'));
  }
  const publicWrite=buildUsageGuide({...defaults,task:'publish',source:'./example',access:'public'});
  assert.match(publicWrite.commands,/cloudskill login/);assert.match(publicWrite.commands,/--public/);assert.match(publicWrite.prompt,/发现真实密钥/);
});
test('host and ID injection are rejected, including secret-bearing URLs and multiline source paths',()=>{
  for(const origin of ['javascript:alert(1)','http://remote.example','https://user:pass@hub.example','https://hub.example/?token=abc','https://hub.example/#secret','https://hub.example/sub'])assert.throws(()=>guideOrigin(origin));
  assert.equal(guideOrigin('http://127.0.0.1:1234'),'http://127.0.0.1:1234');
  for(const field of ['project','skill'])for(const value of ['../private','test;uname',"x'$(whoami)",'x\nscript','x'.repeat(65)])assert.throws(()=>buildUsageGuide({...defaults,[field]:value}));
  for(const source of ['x\nwhoami','x\rgo','a\u0000b','--help'])assert.throws(()=>buildUsageGuide({...defaults,task:'publish',source}));
  for(const invalid of [{task:'delete'},{agent:'unknown'},{access:'all'},{shell:'cmd'}])assert.throws(()=>buildUsageGuide({...defaults,...invalid}));
});
test('setup uses the real source repository and worker branch without server setup or guessing an npm package',()=>{
  const setupText=clientSetup();assert.match(setupText,/git clone --branch worker --single-branch https:\/\/github.com\/lanchenglin\/cloudskill-hub.git/);
  assert.match(setupText,/node cli\/cloudskill.mjs --help/);assert.ok(!/wrangler|npm install -g cloudskill|npx cloudskill/.test(setupText));
  const codex=buildUsageGuide({...defaults,agent:'codex'});assert.match(codex.notice,/当前 CloudSkill 适配器仍写入 CODEX_HOME\/skills/);assert.match(codex.notice,/不要把复制成功当成安装完成/);
});
test('machine-readable instructions work before setup and ignore cookies, forwarded hosts and query data',async()=>{
  const response=await handler(new Request('https://hub.example/usage.md?token=should-not-appear&project=private-name',{
    headers:{Cookie:'irrelevant','Authorization':'Bearer unknown','X-Forwarded-Host':'attacker.example'}}),{});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/markdown/);
  assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('set-cookie'),null);
  const text=await response.text();assert.equal(text,usageMarkdown('https://hub.example'));
  for(const secret of ['should-not-appear','private-name','attacker.example','Bearer unknown'])assert.ok(!text.includes(secret));
  const head=await handler(new Request('https://hub.example/usage.md',{method:'HEAD'}),{});assert.equal(head.status,200);assert.equal(await head.text(),'');
  const post=await handler(new Request('https://hub.example/usage.md',{method:'POST'}),{});assert.equal(post.status,404);
});
test('admin, sign-in and public pages expose help without replacing authentication controls',async()=>{
  const html=await fs.readFile(path.join(root,'public/index.html'),'utf8'),shared=await fs.readFile(path.join(root,'public/shared.html'),'utf8');
  assert.match(html,/data-view="help"/);assert.match(html,/id="view-help"/);assert.match(html,/href="\/usage.html"/);
  for(const id of ['logout','forcePasswordForm','tokenRevealDialog'])assert.ok(html.includes(`id="${id}"`));
  assert.match(shared,/id="sharedGuide"/);assert.match(shared,/href="\/usage.html"/);
  const page=await fs.readFile(path.join(root,'public/usage-page.js'),'utf8');assert.match(page,/credentials:'omit'/);
  assert.ok(!/localStorage|sessionStorage|api\/tokens|api\/auth/.test(page));
});

test('generated commands actually install, update, subscribe and publish with the current CLI',async()=>{
  const f=fixture(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'csh-guide-cli-'));let server;
  try{
    const admin=await setup(f.env);assert.equal((await api(f.env,'/api/projects','POST',{slug:'personal',title:'Guide tests'},admin)).status,201);
    await api(f.env,'/api/projects/personal/skills/example','POST',{files:skill('example'),visibility:'public'},admin);
    await api(f.env,'/api/projects/personal/skills/private-example','POST',{files:skill('private-example'),visibility:'private'},admin);
    const issued=await api(f.env,'/api/tokens','POST',{label:'Guide local test',role:'all_writer',expiresInDays:null},admin);assert.equal(issued.status,201);
    server=http.createServer(async(req,res)=>{try{
      const response=await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half'}),f.env);
      res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
    }catch{res.writeHead(500);res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const env={...process.env,CLOUDSKILL_HOME:path.join(temp,'home'),CLOUDSKILL_CONFIG_DIR:path.join(temp,'config'),
      HERMES_HOME:path.join(temp,'hermes'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CODEX_HOME:path.join(temp,'codex'),CLOUDSKILL_TOKEN:issued.data.token};
    const cli=async(...args)=>promisify(execFile)(process.execPath,[path.join(root,'cli/cloudskill.mjs'),...args],{cwd:temp,env,timeout:30000});
    async function execute(model){
      // Test only known generated cases without embedded apostrophes. Do not use shell evaluation.
      for(const line of model.commands.split('\n').filter(line=>line.startsWith('cloudskill '))){
        const args=[...line.slice(11).matchAll(/'([^']*)'|(\S+)/g)].map(match=>match[1]??match[2]);await cli(...args);
      }
    }
    await execute(buildUsageGuide({...defaults,origin}));
    assert.match(await fs.readFile(path.join(env.HERMES_HOME,'skills/example/SKILL.md'),'utf8'),/name: example/);
    await api(f.env,'/api/projects/personal/skills/example','POST',{files:skill('example',{'references/change.txt':encode64(new TextEncoder().encode('v2'))}),visibility:'public'},admin);
    await execute(buildUsageGuide({...defaults,origin,task:'update'}));
    assert.equal(await fs.readFile(path.join(env.HERMES_HOME,'skills/example/references/change.txt'),'utf8'),'v2');
    await execute(buildUsageGuide({...defaults,origin,task:'subscribe',agent:'claude'}));
    assert.match(await fs.readFile(path.join(env.CLAUDE_CONFIG_DIR,'skills/example/SKILL.md'),'utf8'),/example/);
    await execute(buildUsageGuide({...defaults,origin,access:'private',skill:'private-example'}));
    assert.match(await fs.readFile(path.join(env.HERMES_HOME,'skills/private-example/SKILL.md'),'utf8'),/private-example/);
    const source=path.join(temp,'my-local-skill');await fs.mkdir(source);await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: my-local-skill\ndescription: Guide publish fixture.\n---\n# Safe sample\n');
    await execute(buildUsageGuide({...defaults,origin,task:'publish',source,access:'private'}));
    const result=await api(f.env,'/api/catalog','GET',null,issued.data.token);assert.ok(result.data.skills.some(s=>s.slug==='my-local-skill'&&s.visibility==='private'));
    const guest=await api(f.env,'/api/public/catalog');assert.ok(!guest.data.skills.some(s=>s.slug==='my-local-skill'));
  }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}f.close();await fs.rm(temp,{recursive:true,force:true});}
});
