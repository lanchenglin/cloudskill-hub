import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {pack,unpack,crc32,sha256,layout,verifyPackage} from '../public/lib/archive.js';
import {DEFAULT_LIMITS as L,validateEntries,safeFilePath,resolveLimits} from '../public/lib/policy.js';
const md='---\nname: zip-test\ndescription: Archive test.\n---\n# Test\n';
// Independent ZIP writer permits malicious fixtures our production encoder correctly refuses.
function zip(items){const local=[],central=[];let offset=0;
  for(const e of items){
    const name=Buffer.from(e.name),data=Buffer.from(e.data??''),method=e.method??8,compressed=method===8?deflateRawSync(data):data,crc=e.crc??crc32(data),size=e.size??data.length,flags=e.flags??0x800;
    const h=Buffer.alloc(30+name.length);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(flags,6);h.writeUInt16LE(method,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(size,22);h.writeUInt16LE(name.length,26);name.copy(h,30);
    const c=Buffer.alloc(46+name.length);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(flags,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(((e.mode??0o100644)<<16)>>>0,38);c.writeUInt32LE(offset,42);name.copy(c,46);
    local.push(h,compressed);central.push(c);offset+=h.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return new Blob([...local,directory,end]);
}

test('STORE and DEFLATE ZIPs, wrapper folder, Chinese filenames, executable mode and macOS metadata',async()=>{
  for(const method of [0,8]){
    const pkg=zip([{name:'skill/',mode:0o40755,data:'',method:0},{name:'skill/SKILL.md',data:md,method},{name:'skill/参考/说明.md',data:'中文说明',method},{name:'skill/scripts/run.sh',data:'echo ok\n',mode:0o100755,method},{name:'__MACOSX/.DS_Store',data:'metadata',method}]);
    const decoded=await unpack(pkg);assert.equal(decoded.entries.length,3);assert.equal(decoded.skipped.length,1);
    assert.equal(decoded.entries.find(e=>e.name==='scripts/run.sh').mode,493);
    const canonical=await pack(decoded.entries);assert.equal((await verifyPackage(canonical.blob,canonical.manifest)).length,3);
    assert.equal(await decoded.entries.find(e=>e.name==='参考/说明.md').blob.text(),'中文说明');
  }
});
for(const bad of ['../steal','/etc/passwd','C:/Windows/file','scripts\\evil','.env','.git/config','notes/.secret','assets/CON.txt','LPT1','trailing.','notes/name:stream']){
  test('reject unsafe ZIP path: '+bad,async()=>{await assert.rejects(unpack(zip([{name:'SKILL.md',data:md},{name:bad,data:'bad'}])),/Unsafe/);});
}
test('reject symlink, encryption, wrong CRC, case collision and file/directory collision',async()=>{
  const root={name:'SKILL.md',data:md};
  await assert.rejects(unpack(zip([root,{name:'link',data:'/etc/passwd',mode:0o120777}])),/symlinks/);
  await assert.rejects(unpack(zip([{...root,flags:0x801}])),/Encrypted/);
  await assert.rejects(unpack(zip([root,{name:'broken',data:'broken',crc:1}])),/CRC/);
  await assert.rejects(unpack(zip([root,{name:'Notes.md'},{name:'notes.md'}])),/colliding/);
  await assert.rejects(unpack(zip([root,{name:'notes'},{name:'notes/file'}])),/collision/);
});
test('reject ZIP bombs using declared limits, ratio AND bounded inflated output',async()=>{
  const root={name:'SKILL.md',data:md};
  await assert.rejects(unpack(zip([root,{name:'big',data:'x',size:L.maxFileBytes+1}])),/size/);
  await assert.rejects(unpack(zip([root,{name:'ratio',data:'x'.repeat(1000000)}])),/ratio/);
  // Low reported size evades the ratio precheck; stream output must still be bounded.
  await assert.rejects(unpack(zip([root,{name:'lie',data:randomBytes(65536),size:100}])),/Inflated/);
});
test('reject malformed and duplicate ZIP directories without writing files',async()=>{
  const valid=zip([{name:'SKILL.md',data:md}]);const b=new Uint8Array(await valid.arrayBuffer());
  await assert.rejects(unpack(valid.slice(0,-10)),/directory/);
  await assert.rejects(unpack(zip([{name:'SKILL.md',data:md},{name:'SKILL.md',data:md}])),/Duplicate/);
  const encrypted=b.slice();encrypted[6]|=1;await assert.rejects(unpack(new Blob([encrypted])),/mismatch/);
  const split=b.slice();split[split.length-18]=1;await assert.rejects(unpack(new Blob([split])),/Split/);
});
test('policy exact count/size boundaries, invalid configuration and binary manifest digest',async()=>{
  const entries=[{name:'SKILL.md',size:100},...Array.from({length:999},(_,i)=>({name:`references/file-${i}.txt`,size:0}))];
  assert.equal(validateEntries(entries),100);assert.throws(()=>validateEntries([...entries,{name:'extra',size:0}]),/1–1000/);
  const sizes=[{name:'SKILL.md',size:100},{name:'a',size:20*1024*1024},{name:'b',size:20*1024*1024},{name:'c',size:10*1024*1024-100}];
  assert.equal(validateEntries(sizes),50*1024*1024);sizes[3].size++;assert.throws(()=>validateEntries(sizes),/exceeds/);
  assert.throws(()=>resolveLimits({MAX_FILE_BYTES:0}));assert.throws(()=>resolveLimits({MAX_SKILL_BYTES:999999999}));
  assert.throws(()=>validateEntries([{name:'SKILL.md',size:L.maxSkillMdBytes+1}]),/SKILL.md/);
  const pkg=await pack([{name:'SKILL.md',blob:new Blob([md])},{name:'empty',blob:new Blob([])}]);
  assert.equal((await unpack(pkg.blob)).entries.length,2);
  await assert.rejects(verifyPackage(pkg.blob,{...pkg.manifest,archiveDigest:'0'.repeat(64)}),/SHA-256/);
});
