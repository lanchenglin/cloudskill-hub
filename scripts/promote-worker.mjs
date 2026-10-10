/** Promote one tested main commit to worker. No build, merge commit, force push or cloud API. */
import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function gitCommand(cwd,args,allowed=[0]) {
  const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:60000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  if(result.error)throw Error(`Git ${args[0]} failed: ${result.error.message}`);
  if(!allowed.includes(result.status)) {
    // Do not echo repository URLs, credential helpers, headers or token values.
    throw Error(`Git ${args[0]} failed (exit ${result.status}). Check access, branch protection, network and concurrent changes; no force push was attempted.`);
  }
  return {status:result.status,output:result.stdout.trim()};
}
function remoteHead(cwd,branch,git) {
  const ref=`refs/heads/${branch}`;
  const result=git(cwd,['ls-remote','--exit-code','--heads','origin',ref],[0,2]);
  if(result.status===2)return null; // Only 'no matching ref' means absent, not a network/auth error.
  const lines=result.output.split('\n').filter(Boolean);
  if(lines.length!==1)throw Error(`Unexpected remote ${branch} reference`);
  const [sha,name]=lines[0].split(/\s+/);
  if(name!==ref||!/^[a-f0-9]{40}$/.test(sha))throw Error(`Invalid remote ${branch} reference`);
  return sha;
}
export function assertPromotionContext(env) {
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!=='refs/heads/main')
    throw Error('Promotion is permitted only by the main push CI job after all required tests succeed.');
  if(!/^[a-f0-9]{40}$/.test(env.TESTED_SHA||'')||env.TESTED_SHA!==env.GITHUB_SHA)
    throw Error('TESTED_SHA must equal the exact commit tested by this workflow.');
}

/** git is injectable only for isolated local bare-repository race tests. */
export function promoteWorker({cwd=process.cwd(),testedSha,git=gitCommand}) {
  if(!/^[a-f0-9]{40}$/.test(testedSha||''))throw Error('A full tested commit SHA is required.');
  const checkedOut=git(cwd,['rev-parse','--verify','HEAD^{commit}']).output;
  if(checkedOut!==testedSha)throw Error('Checkout does not match the tested commit; refusing to publish.');
  git(cwd,['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']);
  const main=git(cwd,['rev-parse','refs/remotes/origin/main']).output;
  if(main!==testedSha)return {status:'skipped',reason:'main-advanced',testedSha};
  const previous=remoteHead(cwd,'worker',git);
  if(previous===testedSha)return {status:'current',testedSha,previous};
  if(previous) {
    git(cwd,['fetch','--no-tags','origin','+refs/heads/worker:refs/remotes/origin/worker']);
    const fetched=git(cwd,['rev-parse','refs/remotes/origin/worker']).output;
    if(fetched!==previous)throw Error('worker changed concurrently; retry CI after inspecting its state.');
    if(git(cwd,['merge-base','--is-ancestor',previous,testedSha],[0,1]).status!==0)
      throw Error('worker is ahead of or diverged from this tested commit. Refusing rollback or force push.');
  }
  // A newer main push can arrive while tests or fetches run. Do not publish that untested head.
  if(remoteHead(cwd,'main',git)!==testedSha)return {status:'skipped',reason:'main-advanced',testedSha,previous};
  // Plain push enforces fast-forward on the server as well. A competing newer worker push wins.
  git(cwd,['push','--porcelain','origin',`${testedSha}:refs/heads/worker`]);
  if(remoteHead(cwd,'worker',git)!==testedSha)throw Error('worker changed after push; inspect the remote before retrying.');
  return {status:previous?'promoted':'created',testedSha,previous};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    assertPromotionContext(process.env);
    const result=promoteWorker({testedSha:process.env.TESTED_SHA});
    console.log(JSON.stringify(result,null,2));
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`status=${result.status}\nsha=${result.testedSha}\n`);
    if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## main → worker\n\n- Result: **${result.status}**${result.reason?' ('+result.reason+')':''}\n- Tested commit: \`${result.testedSha}\`\n- Previous worker: \`${result.previous||'none'}\`\n\nGitHub only promotes source. Cloudflare deployment has not been performed by this job.\n`);
  }catch(error){console.error('Promotion stopped:',error.message);process.exitCode=1;}
}
