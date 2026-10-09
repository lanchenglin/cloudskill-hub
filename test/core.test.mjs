import test from 'node:test';
import assert from 'node:assert/strict';
import { decode64, encode64, normalizedFiles, safePath, frontmatter, fileDigest } from '../src/core.js';
import { zipFiles } from '../src/zip.js';
import { skill } from './helpers.mjs';

test('valid Agent Skills and Hermes metadata are preserved',async()=>{
  const files=skill('linux-audit');const normalized=normalizedFiles(files,'linux-audit');
  assert.equal(normalized.meta.name,'linux-audit');
  assert.match(new TextDecoder().decode(decode64(normalized.files['SKILL.md'])),/metadata:\n  hermes:/);
  assert.match(await fileDigest(normalized.files),/^[a-f0-9]{64}$/);
});
test('reject path traversal, invalid names and base64',()=>{
  for(const p of ['../hack','.git/config','/etc/passwd','scripts/../../evil','scripts\\steal','.env'])assert.throws(()=>safePath(p));
  assert.throws(()=>normalizedFiles({'SKILL.md':'%%%'},'test'));
  assert.throws(()=>frontmatter('no frontmatter'));
  assert.throws(()=>normalizedFiles(skill('foo'),'bar'));
});
test('ZIP produces deterministic archive with correct signatures',()=>{
  const files=skill('hello-world',{'references/readme.txt':encode64(new TextEncoder().encode('中文\n'))});
  const a=zipFiles(files),b=zipFiles(files);
  assert.deepEqual(a,b);
  assert.equal(new DataView(a.buffer).getUint32(0,true),0x04034b50);
  assert.equal(new DataView(a.buffer).getUint32(a.length-22,true),0x06054b50);
  assert.equal(new DataView(a.buffer).getUint16(a.length-22+10,true),2);
});

test('folded description and names with quoted YAML scalars',()=>{
  const md='---\nname: "stack-review"\ndescription: >\n  Examine deployment plans and\n  propose safe rollback paths.\nmetadata:\n  hermes:\n    tags: [deployment]\n---\n# Skill\n';
  assert.deepEqual(frontmatter(md),{name:'stack-review',description:'Examine deployment plans and propose safe rollback paths.'});
  assert.throws(()=>safePath('scripts/.npmrc'));
});
