/** Bounded ZIP import and canonical STORE archive layout. No third-party runtime dependency. */
import {DEFAULT_LIMITS,HARD_LIMITS,problem,safeFilePath,validateEntries} from './policy.js';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const table=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
export function crc32(bytes,previous=0){let c=(previous^0xffffffff)>>>0;for(let i=0;i<bytes.length;i++)c=table[(c^bytes[i])&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function u16(b,p){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint16(p,true);}
function u32(b,p){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(p,true);}
function set16(b,p,n){new DataView(b.buffer).setUint16(p,n,true);}
function set32(b,p,n){new DataView(b.buffer).setUint32(p,n>>>0,true);}
export function layout(input,limits=DEFAULT_LIMITS){
  validateEntries(input,limits);
  const entries=input.map(e=>({name:e.name,size:e.size,sha256:e.sha256,crc32:e.crc32,mode:e.mode??420})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  let offset=0;const records=[],centers=[];
  for(const e of entries){
    if(!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isInteger(e.crc32)||e.crc32<0||e.crc32>0xffffffff||![420,493].includes(e.mode))throw problem('Invalid checksum or file mode: '+e.name);
    const name=enc.encode(e.name),head=new Uint8Array(30+name.length),center=new Uint8Array(46+name.length);
    set32(head,0,0x04034b50);set16(head,4,20);set16(head,6,0x800);set16(head,12,33);
    set32(head,14,e.crc32);set32(head,18,e.size);set32(head,22,e.size);set16(head,26,name.length);head.set(name,30);
    set32(center,0,0x02014b50);set16(center,4,0x314);set16(center,6,20);set16(center,8,0x800);set16(center,14,33);
    set32(center,16,e.crc32);set32(center,20,e.size);set32(center,24,e.size);set16(center,28,name.length);set32(center,38,(0x8000|e.mode)<<16);set32(center,42,offset);center.set(name,46);
    records.push({...e,offset:offset+head.length,header:head});centers.push(center);offset+=head.length+e.size;
  }
  const dirSize=centers.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22);
  set32(end,0,0x06054b50);set16(end,8,entries.length);set16(end,10,entries.length);set32(end,12,dirSize);set32(end,16,offset);
  const tail=new Uint8Array(dirSize+22);let p=0;for(const b of [...centers,end]){tail.set(b,p);p+=b.length;}
  const size=offset+tail.length;if(size>limits.maxArchiveBytes)throw problem('Canonical ZIP exceeds archive limit',413);
  return {records,tail,size,entries};
}
/** Build from {name, blob, mode}. Reads at most one raw file at a time for metadata. */
export async function pack(entries,limits=DEFAULT_LIMITS,onProgress=()=>{}){
  validateEntries(entries.map(e=>({name:e.name,size:e.blob.size})),limits);
  const metadata=[],byName=new Map();
  for(const [index,e] of entries.entries()){
    const bytes=new Uint8Array(await e.blob.arrayBuffer());
    metadata.push({name:e.name,size:bytes.length,sha256:await sha256(bytes),crc32:crc32(bytes),mode:e.mode??420});
    // Retain immutable Blob, not the hashing buffer. Browser Files may be disk backed.
    byName.set(e.name,e.blob);onProgress({phase:'hash',done:index+1,total:entries.length});
  }
  const shape=layout(metadata,limits),parts=[];
  for(const r of shape.records)parts.push(r.header,byName.get(r.name));parts.push(shape.tail);
  const blob=new Blob(parts,{type:'application/zip'});
  // WebCrypto has no incremental digest; this bounded allocation is CLIENT-side, never in the Worker.
  const digest=await sha256(await blob.arrayBuffer());
  return {blob,manifest:{files:shape.entries,archiveDigest:digest,archiveBytes:shape.size},layout:shape};
}
export async function boundedBytes(stream,max){
  // Reject missing/NaN/string bounds before comparing any untrusted stream lengths.
  if(!Number.isSafeInteger(max)||max<0)throw problem('A non-negative integer byte limit is required');
  if(!stream||typeof stream.getReader!=='function')throw problem('A readable byte stream is required');
  const reader=stream.getReader(),parts=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max)throw problem('Inflated file exceeds declared size / ZIP bomb',413);parts.push(value);}}
  catch(e){await reader.cancel(e).catch(()=>{});throw e;}finally{reader.releaseLock();}
  const out=new Uint8Array(total);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;
}
/** Parse central directory before inflating; reject unsafe archives rather than extracting on disk. */
export async function unpack(blob,limits=DEFAULT_LIMITS,{stripRoot=true,onProgress=()=>{}}={}){
  if(blob.size>limits.maxArchiveBytes||blob.size<22)throw problem('ZIP size outside policy',413);
  const suffix=new Uint8Array(await blob.slice(Math.max(0,blob.size-65557)).arrayBuffer());let end=-1;
  for(let p=suffix.length-22;p>=0;p--)if(u32(suffix,p)===0x06054b50&&p+22+u16(suffix,p+20)===suffix.length){end=p;break;}
  if(end<0)throw problem('ZIP end directory missing');
  const count=u16(suffix,end+10),dirSize=u32(suffix,end+12),dirOffset=u32(suffix,end+16),endOffset=blob.size-suffix.length+end;
  if(u16(suffix,end+4)||u16(suffix,end+6)||u16(suffix,end+8)!==count||count===65535||dirOffset===0xffffffff||dirSize===0xffffffff)throw problem('Split / ZIP64 archives are unsupported');
  if(count>limits.maxFiles*3||dirSize>2*1024*1024||dirOffset+dirSize!==endOffset)throw problem('Invalid or oversized ZIP directory',413);
  const dir=new Uint8Array(await blob.slice(dirOffset,dirOffset+dirSize).arrayBuffer());let pos=0;const entries=[],spans=[],skipped=[],names=new Set();
  for(let i=0;i<count;i++){
    if(pos+46>dir.length||u32(dir,pos)!==0x02014b50)throw problem('Corrupt ZIP directory');
    const flags=u16(dir,pos+8),method=u16(dir,pos+10),crc=u32(dir,pos+16),compressed=u32(dir,pos+20),size=u32(dir,pos+24),nl=u16(dir,pos+28),xl=u16(dir,pos+30),cl=u16(dir,pos+32),disk=u16(dir,pos+34),attrs=u32(dir,pos+38),off=u32(dir,pos+42),host=dir[pos+5];
    const finish=pos+46+nl+xl+cl;if(finish>dir.length||disk||compressed===0xffffffff||size===0xffffffff||off===0xffffffff)throw problem('Invalid ZIP entry / ZIP64');
    const nb=dir.subarray(pos+46,pos+46+nl);let name;
    try{name=dec.decode(nb);}catch{throw problem('ZIP filenames must be UTF-8 or ASCII');}
    if(!(flags&0x800)&&nb.some(b=>b>127))throw problem('Non-UTF-8 ZIP filenames are unsupported');
    if(flags&~(0x800|8|6)||![0,8].includes(method))throw problem('Encrypted / unsupported ZIP compression');
    const mode=host===3?(attrs>>>16):0,type=mode&0xf000;
    if(type&&type!==0x8000&&type!==0x4000)throw problem('ZIP symlinks and special files are forbidden');
    const directory=name.endsWith('/');
    if(directory&&size!==0||type===0x4000&&!directory)throw problem('Malformed ZIP directory');
    if(names.has(name))throw problem('Duplicate ZIP filename: '+name);names.add(name);
    if(size>limits.maxFileBytes||(size&&(!compressed||size/compressed>limits.maxCompressionRatio)))throw problem('ZIP entry size / compression ratio exceeds policy: '+name,413);
    // Reject ZIP64 extra fields even if the central values are small.
    for(let x=pos+46+nl;x<pos+46+nl+xl;){if(x+4>pos+46+nl+xl)throw problem('Invalid ZIP extra field');const id=u16(dir,x),len=u16(dir,x+2);x+=4;if(id===1||x+len>pos+46+nl+xl)throw problem('ZIP64 / corrupt extra field');x+=len;}
    if(off+30>dirOffset)throw problem('ZIP local header outside data');
    const head=new Uint8Array(await blob.slice(off,off+30).arrayBuffer());
    if(u32(head,0)!==0x04034b50||u16(head,6)!==flags||u16(head,8)!==method)throw problem('ZIP local / central header mismatch');
    const localN=u16(head,26),localX=u16(head,28),start=off+30+localN+localX;
    if(start+compressed>dirOffset)throw problem('ZIP file outside data');
    const localName=new Uint8Array(await blob.slice(off+30,off+30+localN).arrayBuffer());
    if(localN!==nb.length||localName.some((v,n)=>v!==nb[n]))throw problem('ZIP filename mismatch');
    if(!(flags&8)&&(u32(head,14)!==crc||u32(head,18)!==compressed||u32(head,22)!==size))throw problem('ZIP size/checksum header mismatch');
    let spanEnd=start+compressed;
    if(flags&8){
      const descriptor=new Uint8Array(await blob.slice(spanEnd,Math.min(spanEnd+16,dirOffset)).arrayBuffer());let d=descriptor.length>=4&&u32(descriptor,0)===0x08074b50?4:0;
      if(descriptor.length<d+12||u32(descriptor,d)!==crc||u32(descriptor,d+4)!==compressed||u32(descriptor,d+8)!==size)throw problem('Invalid ZIP data descriptor');spanEnd+=d+12;
    }
    spans.push([off,spanEnd]);
    if(name.split('/').includes('__MACOSX')||name.split('/').at(-1)==='.DS_Store'){skipped.push(name);}
    else {safeFilePath(directory?name.slice(0,-1):name,limits);if(!directory)entries.push({name,size,crc32:crc,method,compressed,start,mode:mode&0o111?493:420});}
    pos=finish;
  }
  if(pos!==dir.length)throw problem('Unexpected ZIP directory data');
  spans.sort((a,b)=>a[0]-b[0]);for(let i=0;i<spans.length;i++)if((i===0?spans[i][0]!==0:spans[i][0]!==spans[i-1][1]))throw problem('Overlapping ZIP entries or hidden data');
  if(spans.length&&spans.at(-1)[1]!==dirOffset)throw problem('Unexpected ZIP data before directory');
  if(stripRoot&&!entries.some(e=>e.name==='SKILL.md')){
    const root=entries[0]?.name.split('/')[0];
    if(root&&entries.every(e=>e.name.startsWith(root+'/'))&&entries.some(e=>e.name===root+'/SKILL.md'))for(const e of entries)e.name=e.name.slice(root.length+1);
  }
  validateEntries(entries,limits);
  const result=[];
  for(const [i,e] of entries.entries()){
    let stream=blob.slice(e.start,e.start+e.compressed).stream();
    if(e.method===8){try{stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));}catch{throw problem('This browser cannot decompress ZIP. Use a current browser or upload the extracted folder.');}}
    const bytes=await boundedBytes(stream,e.size);
    if(bytes.length!==e.size||crc32(bytes)!==e.crc32)throw problem('ZIP CRC/size mismatch: '+e.name);
    result.push({name:e.name,blob:new Blob([bytes]),mode:e.mode});onProgress({phase:'unzip',done:i+1,total:entries.length});
  }
  return {entries:result,skipped};
}
/** Validate metadata before opening a network download, not after buffering it. */
export function validatePackageManifest(manifest){
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||
      (manifest.format!==undefined&&manifest.format!==2)||
      !Number.isSafeInteger(manifest.archiveBytes)||manifest.archiveBytes<22||
      manifest.archiveBytes>HARD_LIMITS.maxArchiveBytes||
      typeof manifest.archiveDigest!=='string'||!/^[a-f0-9]{64}$/.test(manifest.archiveDigest))
    throw problem('Invalid downloaded package metadata or size');
  const shape=layout(manifest.files,HARD_LIMITS);
  if(shape.size!==manifest.archiveBytes)throw problem('Archive size does not match file manifest');
  if(manifest.rawBytes!==undefined&&manifest.rawBytes!==validateEntries(shape.entries,HARD_LIMITS))
    throw problem('Raw byte total does not match file manifest');
  return shape;
}
export async function verifyPackage(blob,manifest){
  const shape=validatePackageManifest(manifest);
  if(blob.size!==shape.size)throw problem('Invalid downloaded package size');
  if(await sha256(await blob.arrayBuffer())!==manifest.archiveDigest)throw problem('Downloaded archive SHA-256 mismatch');
  const decoded=await unpack(blob,HARD_LIMITS,{stripRoot:false});
  if(decoded.entries.length!==shape.entries.length)throw problem('Downloaded file count mismatch');
  for(const e of decoded.entries){const expected=shape.entries.find(x=>x.name===e.name);if(!expected||e.blob.size!==expected.size||e.mode!==expected.mode||await sha256(await e.blob.arrayBuffer())!==expected.sha256)throw problem('Downloaded file checksum mismatch: '+e.name);}
  return decoded.entries;
}
