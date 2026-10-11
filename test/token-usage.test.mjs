import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {buildTokenUsage,sharedQuickPrompt} from '../public/lib/token-usage.js';
const token='csh_'+'a'.repeat(48),origin='https://hub.example';
const base={token,origin,role:'all_writer'};
test('token usage is short, binds exactly one chosen credential/Hub and waits for a skill selection',()=>{
  const result=buildTokenUsage(base);
  assert.ok(result.prompt.length<800);assert.equal(result.prompt.split(token).length,2);
  assert.ok(result.prompt.includes(origin+'/usage.md'));
  assert.ok(result.prompt.includes('等我选定后'));
  assert.ok(result.prompt.includes('本次只读取'));assert.ok(result.prompt.includes('不覆盖本地修改'));
  assert.ok(result.prompt.includes('--agents hermes'));
  for(const wrong of ['--force','wrangler deploy','ANTHROPIC_API_KEY','OPENAI_API_KEY'])assert.ok(!result.prompt.includes(wrong)&&!result.commands.includes(wrong));
});
test('client choices change the explicit installation target, never the API provider configuration',()=>{
  for(const agent of ['hermes','claude','codex']){
    const {prompt}=buildTokenUsage({...base,agent});
    assert.ok(prompt.includes('--agents '+agent));
    for(const other of ['hermes','claude','codex'].filter(x=>x!==agent))assert.ok(!prompt.includes('--agents '+other));
  }
  assert.ok(buildTokenUsage({...base,agent:'codex'}).prompt.includes('实际技能加载目录'));
});
test('shared-only instructions do not imply access to private skills or token administration',()=>{
  const {prompt}=buildTokenUsage({...base,role:'shared_writer'});
  assert.ok(prompt.includes('此令牌可读取、修改共享技能'));
  assert.ok(!prompt.includes('共享与私有'));
  assert.ok(buildTokenUsage(base).prompt.includes('此令牌可读取、修改共享与私有技能'));
});
test('untrusted hosts, credential strings, roles and selections cannot enter copied shell code',()=>{
  for(const options of [{origin:'https://evil.example/?token=leak'},{origin:'https://user:pass@evil.example'},{token:token+'\nwhoami'},{role:'admin'},{role:'__proto__'},{agent:'hermes;id'},{shell:'cmd'},{token:null}])assert.throws(()=>buildTokenUsage({...base,...options}));
  assert.ok(buildTokenUsage({...base,origin:'http://127.0.0.1:1234'}).prompt.includes('http://127.0.0.1:1234/usage.md'));
});
test('terminal setup stops on login failure and restores the previous environment',()=>{
  const bash=buildTokenUsage(base).commands,ps=buildTokenUsage({...base,shell:'powershell'}).commands;
  assert.match(bash,/^\(\n/);assert.ok(bash.includes('&& cloudskill list'));assert.ok(bash.endsWith('\n)'));
  assert.ok(ps.includes('$previousToken = $env:CLOUDSKILL_TOKEN'));assert.ok(ps.includes('finally { $env:CLOUDSKILL_TOKEN = $previousToken }'));
  assert.ok(ps.indexOf('if ($LASTEXITCODE -ne 0)')<ps.indexOf('    cloudskill list'));
  assert.ok(!bash.includes('cloudskill install'));assert.ok(!ps.includes('cloudskill install'));
});
test('Bash snippet executes in an isolated scope and never lists after a failed login',{skip:process.platform==='win32'},()=>{
  for(const failure of [false,true]){
    const script=`cloudskill() {\n  test "$CLOUDSKILL_TOKEN" = "$EXPECTED_TOKEN" || return 99\n  echo "$1"\n  if [ "$1" = login ]; then return ${failure?17:0}; fi\n}\nexport CLOUDSKILL_TOKEN=existing-fixture\n${buildTokenUsage(base).commands}\ncode=$?\ntest "$CLOUDSKILL_TOKEN" = existing-fixture || exit 98\nexit "$code"`;
    const result=spawnSync('bash',['-c',script],{env:{...process.env,EXPECTED_TOKEN:token},encoding:'utf8'});
    assert.equal(result.status,failure?17:0,result.stderr);assert.equal(result.stdout,failure?'login\n':'login\nlist\n');assert.ok(!result.stdout.includes(token));
  }
});
test('public quick help never needs a token and is a single short instruction',()=>{
  const text=sharedQuickPrompt(origin,'claude');assert.ok(text.length<300);assert.ok(text.includes('无需 Token'));assert.ok(text.includes('--agents claude'));assert.ok(!text.includes('csh_'));assert.throws(()=>sharedQuickPrompt(origin,'not-a-tool'));
});
test('both help surfaces fold the old wizard; token entry and generated credentials are explicit',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../public/lib/usage-ui.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(html.includes('复制给 AI（含令牌）'));assert.ok(html.includes('复制配置（含令牌）'));assert.ok(html.includes('id="useIssued"'));
  assert.match(ui,/<details class="guide-advanced" data-guide="advanced">/);assert.ok(ui.includes('function selectSkill(skill){\n    get(\'advanced\').open=true;'));
  assert.ok(app.includes("node('button','token-name-button',t.label)"));
  assert.ok(app.includes("$('tokenUsePrompt').value='';$('tokenUseCommands').textContent='';"));
  assert.ok(app.includes('sequence!==revealSequence'));assert.ok(app.includes("Date.parse(tokenUseMeta.expiresAt)>Date.now()"));
});
