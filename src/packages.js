import {layout} from '../public/lib/archive.js';
import {HARD_LIMITS,problem,safeFilePath} from '../public/lib/policy.js';
import {decode64} from './core.js';
export async function readPackage(env,row){
  const object=await env.BUCKET.get(row.artifact_key);if(!object)throw problem('Artifact unavailable',503);
  return JSON.parse(await object.text());
}
export async function fileBody(env,row,relative){
  safeFilePath(relative,HARD_LIMITS);
  const artifact=await readPackage(env,row);
  if(row.artifact_format===2){
    const entry=layout(artifact.files,HARD_LIMITS).records.find(e=>e.name===relative);
    if(!entry)throw problem('File not found',404);
    if(!entry.size)return new Uint8Array();
    const object=await env.BUCKET.get(row.archive_key,{range:{offset:entry.offset,length:entry.size}});
    if(!object)throw problem('Archive unavailable',503);
    return object.body;
  }
  if(!Object.hasOwn(artifact,relative))throw problem('File not found',404);
  return decode64(artifact[relative]);
}
export async function versionPayload(env,row,project,name,version,wantsManifest){
  const base={project,slug:name,version,description:row.description||row.skill_description,digest:row.artifact_digest,format:row.artifact_format};
  if(row.artifact_format===2){
    if(!wantsManifest)throw problem('This version requires CloudSkill CLI >=0.2.0 (binary packages). Upgrade the client.',426);
    return {...base,manifest:await readPackage(env,row),downloadPath:`/api/projects/${project}/skills/${name}/versions/${version}/download`};
  }
  return {...base,files:await readPackage(env,row)};
}
