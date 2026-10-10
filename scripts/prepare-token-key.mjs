#!/usr/bin/env node
/** Prepare a stable local key file for authorized deployment. No Cloudflare calls,
 * no key output, no overwrite/rotation. Check the remote Secret before uploading.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
function outside(root,dir){
  const relative=path.relative(root,dir);
  if(!(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)))
    throw Error('Token key must be stored outside the Git repository');
}
export async function prepareTokenKey(directory){
  if(typeof directory!=='string'||!directory.trim())throw Error('Specify an external private credentials directory');
  const dir=path.resolve(directory);outside(sourceRoot,dir);
  // Refuse symlink paths rather than accidentally placing secrets inside Git or a shared directory.
  for(let current=dir;;current=path.dirname(current)){
    try{if((await fs.lstat(current)).isSymbolicLink())throw Error('Token-key directory path must not contain symlinks');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(current===path.dirname(current))break;
  }
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const stat=await fs.lstat(dir);outside(await fs.realpath(sourceRoot),await fs.realpath(dir));
  if(!stat.isDirectory()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))
    throw Error('Token-key directory must be private (0700 on Unix); verify Windows ACLs separately');
  const filename=path.join(dir,'token-encryption.json');let created=false;
  let handle;
  try{handle=await fs.open(filename,'wx',0o600);}
  catch(error){if(error.code!=='EEXIST')throw error;}
  if(handle){
    try{await handle.writeFile(JSON.stringify({TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')})+'\n');await handle.sync();created=true;}
    catch(error){await fs.rm(filename,{force:true});throw error;}
    finally{await handle.close();}
  }
  const existing=await fs.lstat(filename);
  if(!existing.isFile()||existing.isSymbolicLink()||existing.size>4096||(process.platform!=='win32'&&(existing.mode&0o077)!==0))
    throw Error('Existing token key file must be a private regular file; it was not overwritten');
  let saved;try{saved=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw Error('Invalid saved token key file; it was not overwritten');}
  if(!saved||Object.keys(saved).length!==1||typeof saved.TOKEN_ENCRYPTION_KEY!=='string'||!/^[a-f0-9]{64}$/.test(saved.TOKEN_ENCRYPTION_KEY))
    throw Error('Invalid saved token key file; it was not overwritten');
  return {path:filename,created};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  (async()=>{
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==='--help'){
      console.log('Usage: node scripts/prepare-token-key.mjs --credentials-dir /PRIVATE/DIRECTORY\nCreates/reuses token-encryption.json without printing its key. No cloud changes. Preserve this key for future deployments; never replace an existing remote Secret with a newly generated key.');return;
    }
    if(args.length!==2||args[0]!=='--credentials-dir'||args[1].startsWith('--'))throw Error('Use --credentials-dir /PRIVATE/DIRECTORY');
    const result=await prepareTokenKey(args[1]);
    console.log((result.created?'Created private token key file: ':'Reusing private token key file: ')+result.path);
    console.log('Key not printed. Back up this file securely. It is NOT the temporary bootstrap secret.');
  })().catch(error=>{console.error('Token-key preparation stopped:',error.message);process.exitCode=1;});
}
