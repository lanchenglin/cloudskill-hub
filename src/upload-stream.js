/** Stream verification for canonical ZIPs. Never reads a complete archive into Worker memory. */
import {createHash} from 'node:crypto';
import * as zlib from 'node:zlib';
import {layout,crc32} from '../public/lib/archive.js';
import {problem} from '../public/lib/policy.js';
import {frontmatter} from './core.js';
const crc=(bytes,prev)=>typeof zlib.crc32==='function'?zlib.crc32(bytes,prev):crc32(bytes,prev);
export function archiveVerifier(manifest,limits,expectedName){
  const shape=layout(manifest.files,limits);
  if(shape.size!==manifest.archiveBytes)throw problem('Archive size does not match manifest');
  const sections=[];
  for(const r of shape.records)sections.push({literal:r.header,size:r.header.length},{file:r,size:r.size});
  sections.push({literal:shape.tail,size:shape.tail.length});
  let section=0,position=0,total=0,fileHash=null,fileCrc=0,skillChunks=[],skillLength=0;
  const fullHash=createHash('sha256');
  const result={metadata:null,stream:null};
  function advance(){
    while(section<sections.length&&position===sections[section].size){
      const cur=sections[section];
      if(cur.file){
        const hash=(fileHash||createHash('sha256')).digest('hex');
        if(hash!==cur.file.sha256||fileCrc!==cur.file.crc32)throw problem('File checksum mismatch: '+cur.file.name);
        fileHash=null;fileCrc=0;
      }
      section++;position=0;
    }
  }
  result.stream=new TransformStream({
    transform(chunk,controller){
      if(!(chunk instanceof Uint8Array))throw problem('Upload must contain binary bytes');
      total+=chunk.length;if(total>shape.size)throw problem('Archive exceeds declared size',413);
      fullHash.update(chunk);let at=0;
      while(at<chunk.length){
        advance();if(section>=sections.length)throw problem('Unexpected archive trailing bytes');
        const cur=sections[section],n=Math.min(chunk.length-at,cur.size-position),bytes=chunk.subarray(at,at+n);
        if(cur.literal){for(let i=0;i<n;i++)if(bytes[i]!==cur.literal[position+i])throw problem('Archive is not the declared canonical ZIP');}
        else {
          (fileHash??=createHash('sha256')).update(bytes);fileCrc=crc(bytes,fileCrc);
          if(cur.file.name==='SKILL.md'){skillLength+=n;if(skillLength>limits.maxSkillMdBytes)throw problem('SKILL.md too large',413);skillChunks.push(bytes.slice());}
        }
        position+=n;at+=n;
      }
      // TransformStream backpressure forwards the same bounded chunk rather than accumulating the ZIP.
      controller.enqueue(chunk);
    },
    flush(){
      advance();if(total!==shape.size||section!==sections.length)throw problem('Truncated archive');
      if(fullHash.digest('hex')!==manifest.archiveDigest)throw problem('Archive SHA-256 mismatch');
      const md=new Uint8Array(skillLength);let at=0;for(const b of skillChunks){md.set(b,at);at+=b.length;}
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(md);}catch{throw problem('SKILL.md must be valid UTF-8');}
      const meta=frontmatter(text);if(meta.name!==expectedName)throw problem('SKILL.md name does not match upload target');
      result.metadata=meta;skillChunks=[];
    }
  });
  return result;
}
export async function putVerified(request,bucket,key,manifest,limits,name){
  if(!request.body)throw problem('Missing ZIP body');
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/zip')throw problem('Expected application/zip',415);
  if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')throw problem('HTTP Content-Encoding is unsupported',415);
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==manifest.archiveBytes))throw problem('Content-Length does not match manifest',413);
  const verifier=archiveVerifier(manifest,limits,name),abort=new AbortController();
  // R2 requires a known-length stream. In Workers FixedLengthStream supplies this without buffering.
  const fixed=typeof globalThis.FixedLengthStream==='function'?new globalThis.FixedLengthStream(manifest.archiveBytes):new TransformStream();
  const pump=request.body.pipeThrough(verifier.stream).pipeTo(fixed.writable,{signal:abort.signal});
  const write=bucket.put(key,fixed.readable,{sha256:manifest.archiveDigest,httpMetadata:{contentType:'application/zip'}});
  try{await Promise.all([pump,write]);if(!verifier.metadata)throw problem('Archive validation did not complete');return verifier.metadata;}
  catch(error){abort.abort(error);await Promise.allSettled([pump,write]);throw error;}
}
