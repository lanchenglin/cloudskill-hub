import {createHash,randomBytes} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {handler} from '../src/index.js';
import {encode64,randomId,tokenHash,now} from '../src/core.js';

class DbAdapter {
  constructor(db){this.db=db;}
  async batch(statements){
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=[];for(const s of statements)result.push(await s.run());this.db.exec('COMMIT');return result;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  prepare(sql){const stmt=this.db.prepare(sql);let values=[];return {
    bind(...args){values=args;return this;},
    async first(){return stmt.get(...values)||null;},
    async all(){return {results:stmt.all(...values)};},
    async run(){const r=stmt.run(...values);return {meta:{changes:r.changes}};}
  };}
}
export class Bucket {
  constructor(){this.objects=new Map();}
  async put(key,value,options={}){
    const bytes=value instanceof ReadableStream?Buffer.from(await new Response(value).arrayBuffer()):Buffer.from(value);
    if(options.sha256&&createHash('sha256').update(bytes).digest('hex')!==options.sha256)throw Error('R2 checksum mismatch');
    this.objects.set(key,bytes);return {key,size:bytes.length};
  }
  async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.objects.delete(key);}
  async head(key){const bytes=this.objects.get(key);return bytes?{key,size:bytes.length}:null;}
  async get(key,options={}){
    const original=this.objects.get(key);if(!original)return null;
    const bytes=options.range?original.subarray(options.range.offset,options.range.offset+options.range.length):original;
    return {key,size:original.length,body:new Blob([bytes]).stream(),text:async()=>bytes.toString('utf8'),arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
  }
}
export function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const env={DB:new DbAdapter(db),BUCKET:new Bucket(),BOOTSTRAP_SECRET:'test-bootstrap-secret-with-adequate-length',TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
  return {env,db,close:()=>db.close()};
}
export const skill=(name='sample-skill',extra={})=>({'SKILL.md':encode64(new TextEncoder().encode(`---\nname: ${name}\ndescription: An example skill for testing integrations.\nmetadata:\n  hermes:\n    tags: [testing]\n---\n# ${name}\nUse safely.\n`)),...extra});
export async function api(env,path,method='GET',data=null,token=null){
  const url='https://hub.example'+path;
  const headers={...(token?{Authorization:`Bearer ${token}`}:{})};
  if(data){headers['Content-Type']='application/json';}
  const response=await handler(new Request(url,{method,headers,body:data?JSON.stringify(data):undefined}),env);
  return {response,status:response.status,data:await response.json()};
}
// Compatibility fixtures model an existing API-admin instance. Fresh password setup is
// exercised through the public API in auth.test.mjs and the native/browser smoke tests.
export async function setup(env){
  const token=randomId('csh_');
  await env.DB.prepare("INSERT INTO access_tokens (id,label,token_hash,role,project_scope,created_at) VALUES (?,?,?,'admin','[]',?)")
    .bind(randomId('t_'),'Legacy test administrator',await tokenHash(token),now()).run();
  return token;
}

/** Pre-migration fixture only: new HTTP issuance must NOT create these legacy types. */
export async function legacyToken(env,label,role,projects){
  if(!['publisher','client'].includes(role))throw Error('Invalid legacy fixture role');
  const token=randomId('csh_'),id=randomId('t_'),expiresAt=new Date(Date.now()+90*86400000).toISOString();
  await env.DB.prepare("INSERT INTO access_tokens(id,label,token_hash,role,project_scope,created_at,can_publish,credential_type,expires_at) VALUES(?,?,?,'client',?,?,?,'api',?)")
    .bind(id,label,await tokenHash(token),JSON.stringify(projects),now(),role==='publisher'?1:0,expiresAt).run();
  return {id,token,role,projects,expiresAt};
}
