/** Deterministic STORE-only ZIP for standards-compliant Agent Skills archives. */
import { decode64, safePath } from './core.js';
const text = new TextEncoder();
const table = new Uint32Array(256);
for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1; table[n]=c >>> 0; }
export function crc32(bytes) {let c=0xffffffff; for(const b of bytes)c=table[(c ^ b) & 255] ^ (c >>> 8);return (c ^ 0xffffffff) >>> 0;}
function chunk(n) {return new Uint8Array(n);}
function w16(d,o,n){d[o]=n&255;d[o+1]=(n>>>8)&255;}
function w32(d,o,n){w16(d,o,n);w16(d,o+2,n>>>16);}
export function zipFiles(files) {
  const parts=[], directory=[];let offset=0;
  for (const [name,base64] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en'))) {
    safePath(name); const nameBytes=text.encode(name); const data=decode64(base64);const crc=crc32(data);
    if(nameBytes.length>65535)throw new Error('File name too long');
    const head=chunk(30+nameBytes.length);w32(head,0,0x04034b50);w16(head,4,20);w16(head,6,0x800);w16(head,8,0);w16(head,10,0);w16(head,12,33); // 1980-01-01
    w32(head,14,crc);w32(head,18,data.length);w32(head,22,data.length);w16(head,26,nameBytes.length);head.set(nameBytes,30);
    parts.push(head,data);
    const center=chunk(46+nameBytes.length);w32(center,0,0x02014b50);w16(center,4,20);w16(center,6,20);w16(center,8,0x800);w16(center,10,0);w16(center,12,0);w16(center,14,33);
    w32(center,16,crc);w32(center,20,data.length);w32(center,24,data.length);w16(center,28,nameBytes.length);w32(center,42,offset);center.set(nameBytes,46);
    directory.push(center);offset+=head.length+data.length;
  }
  const dirSize=directory.reduce((n,part)=>n+part.length,0);
  const end=chunk(22);w32(end,0,0x06054b50);w16(end,8,directory.length);w16(end,10,directory.length);w32(end,12,dirSize);w32(end,16,offset);
  const out=chunk(offset+dirSize+22);let at=0;
  for(const part of [...parts,...directory,end]){out.set(part,at);at+=part.length;}
  return out;
}
