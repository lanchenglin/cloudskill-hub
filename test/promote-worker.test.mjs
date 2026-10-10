import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitCommand,promoteWorker,assertPromotionContext} from '../scripts/promote-worker.mjs';

const run=(cwd,...args)=>gitCommand(cwd,args).output;
function fixture() {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'csh-release-test-'));
  const bare=path.join(temp,'remote.git'),seed=path.join(temp,'seed'),runner=path.join(temp,'runner');
  run(temp,'init','--bare',bare);run(temp,'init','--initial-branch=main',seed);
  run(seed,'config','user.name','Release fixture');run(seed,'config','user.email','test@example.invalid');
  run(seed,'config','commit.gpgsign','false');run(seed,'config','core.autocrlf','false');
  run(seed,'remote','add','origin',bare);
  let serial=0;
  const commit=()=>{fs.writeFileSync(path.join(seed,'fixture.txt'),`revision ${++serial}\n`);run(seed,'add','fixture.txt');run(seed,'commit','-m',`fixture ${serial}`);return run(seed,'rev-parse','HEAD');};
  const first=commit();run(seed,'push','origin','main');run(bare,'symbolic-ref','HEAD','refs/heads/main');
  run(temp,'clone','--no-local',bare,runner);
  const checkout=sha=>{run(runner,'fetch','origin');run(runner,'checkout','--detach',sha);};
  const worker=()=>{const r=gitCommand(seed,['ls-remote','--exit-code','--heads','origin','refs/heads/worker'],[0,2]);return r.status===2?null:r.output.split(/\s+/)[0];};
  return {temp,bare,seed,runner,first,commit,checkout,worker,close:()=>fs.rmSync(temp,{recursive:true,force:true})};
}

test('release creates worker at exactly the tested commit and rerunning is idempotent',()=>{
  const f=fixture();try {
    const a=promoteWorker({cwd:f.runner,testedSha:f.first});assert.equal(a.status,'created');assert.equal(f.worker(),f.first);
    assert.equal(promoteWorker({cwd:f.runner,testedSha:f.first}).status,'current');
    assert.equal(run(f.bare,'rev-list','--count','worker'),'1');
  }finally{f.close();}
});
test('release advances worker without new commits or changing the main source tree',()=>{
  const f=fixture();try {
    run(f.seed,'push','origin',`${f.first}:refs/heads/worker`);
    const next=f.commit();run(f.seed,'push','origin','main');f.checkout(next);
    const result=promoteWorker({cwd:f.runner,testedSha:next});assert.equal(result.status,'promoted');assert.equal(result.previous,f.first);
    assert.equal(f.worker(),next);assert.equal(run(f.bare,'rev-parse','worker^{tree}'),run(f.bare,'rev-parse','main^{tree}'));
  }finally{f.close();}
});
test('late CI result skips when main has advanced, never publishing the newer untested head',()=>{
  const f=fixture();try {
    run(f.seed,'push','origin',`${f.first}:refs/heads/worker`);
    const newer=f.commit();run(f.seed,'push','origin','main');
    const result=promoteWorker({cwd:f.runner,testedSha:f.first});assert.equal(result.reason,'main-advanced');
    assert.equal(f.worker(),f.first);assert.notEqual(f.worker(),newer);
  }finally{f.close();}
});
test('diverged worker is refused rather than force-pushed or merged',()=>{
  const f=fixture();try {
    const main=f.commit();run(f.seed,'push','origin','main');f.checkout(main);
    run(f.seed,'checkout','-b','separate',f.first);const separate=f.commit();run(f.seed,'push','origin',`${separate}:refs/heads/worker`);
    assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:main}),/diverged/);assert.equal(f.worker(),separate);
  }finally{f.close();}
});
test('a worker ahead of tested main is never rolled back',()=>{
  const f=fixture();try {
    const ahead=f.commit();run(f.seed,'push','origin',`${ahead}:refs/heads/worker`);
    assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:f.first}),/ahead/);assert.equal(f.worker(),ahead);
  }finally{f.close();}
});
test('main advancing immediately before promotion is checked again',()=>{
  const f=fixture();try {
    const git=(cwd,args,allowed)=>{
      if(args[0]==='ls-remote'&&args.at(-1)==='refs/heads/main'){f.commit();run(f.seed,'push','origin','main');}
      return gitCommand(cwd,args,allowed);
    };
    const result=promoteWorker({cwd:f.runner,testedSha:f.first,git});assert.equal(result.reason,'main-advanced');assert.equal(f.worker(),null);
  }finally{f.close();}
});
test('competing worker update wins and non-fast-forward push is not retried with force',()=>{
  const f=fixture();try {
    const next=f.commit();run(f.seed,'push','origin','main');f.checkout(next);
    run(f.seed,'push','origin',`${f.first}:refs/heads/worker`);const ahead=f.commit();
    const git=(cwd,args,allowed)=>{
      if(args[0]==='push')run(f.seed,'push','origin',`${ahead}:refs/heads/worker`);
      assert.ok(!args.includes('--force'));assert.ok(!args.some(x=>x.startsWith('--force-with-lease')));
      return gitCommand(cwd,args,allowed);
    };
    assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:next,git}),/Git push failed/);assert.equal(f.worker(),ahead);
  }finally{f.close();}
});
test('network/remote errors are not treated as an absent worker and cause no writes',()=>{
  const f=fixture();try {
    const git=(cwd,args,allowed)=>{if(args[0]==='ls-remote')throw Error('Simulated remote outage');return gitCommand(cwd,args,allowed);};
    assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:f.first,git}),/outage/);assert.equal(f.worker(),null);
  }finally{f.close();}
});
test('invalid or mismatched tested SHA fails closed before promotion',()=>{
  const f=fixture();try {
    for(const value of [undefined,'main','--all','a'.repeat(39)])assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:value}),/full tested/);
    assert.throws(()=>promoteWorker({cwd:f.runner,testedSha:'0'.repeat(40)}),/does not match/);assert.equal(f.worker(),null);
  }finally{f.close();}
});
test('entrypoint permits only main push CI with an exact tested SHA',()=>{
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),TESTED_SHA:'a'.repeat(40)};
  assert.doesNotThrow(()=>assertPromotionContext(env));
  for(const extra of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'workflow_dispatch'},
    {GITHUB_REF:'refs/heads/worker'},{GITHUB_REF:'refs/heads/feature'},{TESTED_SHA:'b'.repeat(40)}])
    assert.throws(()=>assertPromotionContext({...env,...extra}));
});
test('release workflow is gated on every test job and the duplicate cloud deploy workflow is absent',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const text=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
  const promotion=text.slice(text.indexOf('  promote-worker:'));
  assert.match(promotion,/needs: \[test, worker-runtime, browser\]/);
  for(const job of ['test','worker-runtime','browser'])assert.ok(promotion.includes(`needs.${job}.result == 'success'`));
  assert.ok(promotion.includes("github.event_name == 'push'"));assert.ok(promotion.includes("github.ref == 'refs/heads/main'"));
  assert.match(promotion,/contents: write/);assert.match(promotion,/cancel-in-progress: false/);
  assert.ok(promotion.includes('ref: ${{ github.sha }}'));assert.ok(promotion.includes('TESTED_SHA: ${{ github.sha }}'));
  assert.match(text,/branches-ignore: \[worker\]/);assert.ok(!text.includes('continue-on-error: true'));
  assert.ok(!fs.existsSync(path.join(root,'.github/workflows/deploy.yml')));
  assert.ok(!text.includes('CLOUDFLARE_API_TOKEN'));assert.ok(!text.includes('npm run deploy'));
});
