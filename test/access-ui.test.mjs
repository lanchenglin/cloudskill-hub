import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TOKEN_ROLES,STATUS_LABELS,tokenStatus,tokenSummary,filterTokens,displayDate,tokenLifetime} from '../public/lib/access-ui.js';
const time=Date.parse('2026-10-10T12:00:00Z');
const permanent={id:'one',label:'My Hermes',role:'all_writer',expires_at:null,revoked_at:null};
const finite={id:'two',label:'Public Claude',role:'shared_writer',expires_at:'2027-01-01T00:00:00Z',revoked_at:null};
const expired={id:'three',label:'Old CLI',role:'shared_writer',expires_at:'2026-01-01T00:00:00Z',revoked_at:null};
const revoked={...permanent,id:'four',label:'Removed',revoked_at:'2026-10-09T12:00:00Z'};
test('access list treats permanent, finite, exact expiry and revocation distinctly',()=>{
  assert.equal(tokenStatus(permanent,time),'active');assert.equal(tokenStatus(finite,time),'active');
  assert.equal(tokenStatus(expired,time),'expired');assert.equal(tokenStatus({...finite,expires_at:new Date(time).toISOString()},time),'expired');
  assert.equal(tokenStatus(revoked,time),'revoked');assert.equal(tokenStatus({...expired,revoked_at:'yesterday'},time),'revoked');
});
test('missing or invalid dates are not falsely presented as permanent or active',()=>{
  for(const value of [undefined,'','nonsense',0,false])assert.equal(tokenStatus({expires_at:value},time),'unknown');
  assert.equal(tokenLifetime({}),'期限未知');assert.equal(displayDate('invalid'),'时间未知');
  assert.equal(displayDate(null),'从未使用');assert.equal(tokenLifetime(permanent),'永久有效');
});
test('summary counts full inventory regardless of current filters',()=>{
  assert.deepEqual(tokenSummary([permanent,finite,expired,revoked,{}],time),{total:5,active:2,expired:1,revoked:1,unknown:1});
  assert.equal(tokenSummary([],time).total,0);
});
test('metadata filters combine label, role and status without changing source entries',()=>{
  const records=[permanent,finite,expired,revoked];const saved=JSON.stringify(records);
  assert.deepEqual(filterTokens(records,{query:'  HERMES  ',role:'all_writer',status:'active'},time),[permanent]);
  assert.deepEqual(filterTokens(records,{role:'shared_writer',status:'expired'},time),[expired]);
  assert.deepEqual(filterTokens(records,{query:'not-found'},time),[]);assert.equal(JSON.stringify(records),saved);
});
test('search only examines the label, not secret values, ids or encryption metadata',()=>{
  const record={...permanent,id:'do-not-search-id',token:'sensitive',token_ciphertext:'cipher',token_hash:'hash'};
  for(const query of ['sensitive','cipher','hash','do-not-search-id'])assert.deepEqual(filterTokens([record],{query},time),[]);
  assert.equal(filterTokens([{...permanent,label:'中文运维 🔑'}],{query:'运维'},time).length,1);
});
test('legacy labels remain recognizable without making up new write permissions',()=>{
  assert.equal(TOKEN_ROLES.shared_writer,'修改共享技能');assert.equal(TOKEN_ROLES.all_writer,'修改全部技能');
  assert.equal(TOKEN_ROLES.publisher,'旧项目发布令牌');assert.equal(STATUS_LABELS.revoked,'已撤销');
});
test('access, project and account forms live in distinct sections with a single header logout',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const section=name=>html.match(new RegExp(`<section id="view-${name}"[\\s\\S]*?</section>`))[0];
  assert.ok(section('security').includes('id="tokensList"'));
  assert.ok(!section('security').includes('id="projectForm"'));assert.ok(!section('security').includes('id="passwordForm"'));
  assert.ok(section('projects').includes('id="projectForm"'));assert.ok(section('account').includes('id="passwordForm"'));
  const header=html.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  assert.match(header,/id="logout"[^>]*data-logout[^>]*>退出登录<\/button>/);
  assert.equal((html.match(/id="logout"/g)||[]).length,1);
  assert.match(html,/<dialog id="tokenCreateDialog" aria-labelledby="tokenCreateTitle">/);
  assert.match(html,/<details id="tokenDangerZone"/);
});
test('presentation does not remove first-login, password or recoverable-token controls',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for(const id of ['forcePasswordForm','forceLogout','tokenRevealDialog','copyTokenValue','hideTokenValue','tokenDays','tokenRole'])assert.ok(html.includes('id="'+id+'"'));
  for(const id of ['tokenLabel','tokenRole','tokenDays','tokenSearch'])assert.ok(html.includes('id="'+id+'"'));
  assert.ok(html.includes('value="never"'));assert.ok(html.includes('value="all_writer"'));
});
