#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomBytes } from 'node:crypto';
import { hubOrigin, parseAgents, loadConfig, saveConfig, loadState, request, catalog, install, check, heartbeat, subscribe, sync, localFiles, files, withLock, readJson } from './manager.mjs';
import { frontmatter, decode64 } from '../src/core.js';

const USAGE=`CloudSkill Hub CLI — independent Agent Skills management\n\nCommands:\n  cloudskill login https://YOUR-HUB             Login (token via CLOUDSKILL_TOKEN or interactive prompt)\n  cloudskill whoami                              Check account permissions\n  cloudskill projects                            List accessible projects\n  cloudskill list [project]                      List private and public Skills\n  cloudskill publish <project> <folder> [--public] Upload a Skill folder (admin only)\n  cloudskill install <project>/<skill> [--agents claude,codex,hermes] [--force] [--dry-run]\n  cloudskill subscribe <project> [--agents ...] [--skills skill1,skill2|*]\n  cloudskill sync [--force] [--dry-run]           Install/update subscribed Skills\n  cloudskill check                               Check updates and local modifications\n  cloudskill update [--force] [--dry-run]         Update previously installed Skills\n  cloudskill status                              Local device inventory + send heartbeat\n  cloudskill logout                              Remove local credentials (does NOT revoke remote token)\n`;
function option(args,key){const idx=args.indexOf(`--${key}`);return idx<0?undefined:args[idx+1];}
function flag(args,name){return args.includes(`--${name}`);}
function print(data){console.log(JSON.stringify(data,null,2));}
function options(args){return {force:flag(args,'force'),dryRun:flag(args,'dry-run')};}
async function main(){const [command,...args]=process.argv.slice(2);
  if(!command||command==='help'||command==='--help')return console.log(USAGE);
  if(command==='login'){
    const url=hubOrigin(args[0]);let token=process.env.CLOUDSKILL_TOKEN;
    if(!token){if(!process.stdin.isTTY)throw Error('Set CLOUDSKILL_TOKEN in the environment for noninteractive login');
      const rl=createInterface({input,output});try{token=(await rl.question('Paste your Hub access token (input will be visible): ')).trim();}finally{rl.close();}}
    // Validate before modifying the on-disk login so a typo never destroys a valid device session.
    const identity=await request({url,token},'GET','/api/me');
    const previous=await readJson(files().config,null);
    const preserve=previous?.url===url;
    const config=await saveConfig({url,token,
      device:preserve?previous.device:`${os.hostname().replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,40)}-${randomBytes(5).toString('hex')}`,
      subscriptions:preserve?previous.subscriptions:[],
    });
    console.log(`✓ Authorized: ${identity.label} (${identity.role}); device ${config.device}`);return;
  }
  if(command==='logout'){await fs.rm(files().config,{force:true});console.log('Local credential removed; revoke it in the Hub if the device is lost.');return;}
  const config=await loadConfig();
  if(command==='whoami')return print(await request(config,'GET','/api/me'));
  if(command==='projects')return print(await request(config,'GET','/api/projects'));
  if(command==='list')return print((await catalog(config)).filter(x=>!args[0]||x.project===args[0]));
  if(command==='publish'){
    const project=args[0],folder=args[1];if(!project||!folder)throw Error('Usage: publish <project> <folder> [--public]');
    const items=await localFiles(path.resolve(folder));const name=frontmatter(new TextDecoder().decode(decode64(items['SKILL.md']))).name;
    const result=await request(config,'POST',`/api/projects/${project}/skills/${name}`,{files:items,visibility:flag(args,'public')?'public':'private'});
    print(result);return;
  }
  if(command==='install'){
    const parts=(args[0]||'').split('/');if(parts.length!==2)throw Error('Usage: install <project>/<skill>');
    return print(await withLock(()=>install(config,parts[0],parts[1],parseAgents(option(args,'agents')),options(args))));
  }
  if(command==='subscribe'){
    if(!args[0])throw Error('Usage: subscribe <project> [--agents ...] [--skills *]');
    return print(await subscribe(config,args[0],parseAgents(option(args,'agents')),(option(args,'skills')||'*').split(',')));
  }
  if(command==='sync')return print(await withLock(()=>sync(config,options(args))));
  if(command==='check')return print(await check(config));
  if(command==='update')return withLock(async()=>{
    const state=await loadState();const out=[];
    const todo=[...new Set(Object.values(state.installed).map(r=>`${r.project}/${r.slug}`))];
    const allowed=new Set((await request(config,'GET','/api/projects')).projects.map(p=>p.slug));
    for(const item of todo){const [project,name]=item.split('/');if(!allowed.has(project)){out.push({project,name,status:'skipped',reason:'token no longer has project access'});continue;}
      const agents=Object.values(state.installed).filter(r=>r.project===project&&r.slug===name).map(r=>r.agent);
      out.push(...await install(config,project,name,agents,options(args)));}
    if(!flag(args,'dry-run'))await heartbeat(config);return print(out);
  });
  if(command==='status'){const state=await loadState();let syncStatus='reported';try{await heartbeat(config);}catch(e){syncStatus='not reported: '+e.message;}return print({device:config.device,heartbeat:syncStatus,installed:Object.values(state.installed),subscriptions:config.subscriptions});}
  throw Error('Unknown command: '+command+'\n\n'+USAGE);
}
main().catch(e=>{console.error('Error:',e.message);process.exitCode=1;});
