import {createHash} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {handler} from '../src/index.js';
import {encode64} from '../src/core.js';

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
  const env={DB:new DbAdapter(db),BUCKET:new Bucket(),BOOTSTRAP_SECRET:'test-bootstrap-secret-with-adequate-length'};
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
export async function setup(env){
  const resp=await api(env,'/api/bootstrap','POST',{secret:env.BOOTSTRAP_SECRET});
  if(resp.status!==201)throw new Error('Test bootstrap failed: '+JSON.stringify(resp.data));
  return resp.data.token;
}
