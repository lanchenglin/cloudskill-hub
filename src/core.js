import {frontmatter} from '../public/lib/metadata.js';
export {frontmatter};
/** Shared validation and content hashing, with no runtime dependencies. */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILES = 200;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const enc = new TextEncoder();

export function invalid(msg) { const error = new Error(msg); error.status = 400; return error; }
export function slug(value) {
  if (typeof value !== 'string' || value.length > 64 || !NAME_RE.test(value)) throw invalid('Invalid slug: lowercase letters, numbers, hyphens only (1–64 chars)');
  return value;
}
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\\') || value.startsWith('/') || value.includes('\0')) throw invalid('Unsafe filename');
  const segs = value.split('/');
  if (segs.some(x => !x || x === '.' || x === '..' || x.startsWith('.'))) throw invalid('Unsafe path segment: ' + value);
  return value;
}
export function decode64(s) {
  if (typeof s !== 'string' || s.length > 6_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw invalid('Invalid file base64');
  const binary = atob(s); const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function encode64(bytes) {
  let result=''; const chunk=16_384;
  for (let i=0;i<bytes.length;i+=chunk) result += String.fromCharCode(...bytes.subarray(i, i+chunk));
  return btoa(result);
}
export function normalizedFiles(input, expectedSlug) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('files object required');
  const entries = Object.entries(input);
  if (!entries.length || entries.length > MAX_FILES || !Object.hasOwn(input,'SKILL.md')) throw invalid('Expected SKILL.md and 1–200 files');
  let total=0; const files={};
  for (const [name,base64] of entries.sort(([a],[b]) => a.localeCompare(b,'en'))) {
    safePath(name);
    const bytes=decode64(base64);
    if (bytes.length > MAX_FILE) throw invalid(`${name} exceeds 4 MiB`);
    total+=bytes.length;
    if (total > MAX_BYTES) throw invalid('Bundle exceeds 6 MiB');
    files[name]=encode64(bytes); // normalize representation before hashing
  }
  let content;
  try { content = new TextDecoder('utf-8',{fatal:true}).decode(decode64(files['SKILL.md'])); }
  catch { throw invalid('SKILL.md must be valid UTF-8'); }
  const meta=frontmatter(content);
  if (expectedSlug && meta.name !== expectedSlug) throw invalid(`SKILL.md name must match URL slug: ${expectedSlug}`);
  return {files, meta};
}
export function serializeFiles(files) { return JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')))); }
export async function sha256(bytes) { const hash=await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
export async function fileDigest(files) { return await sha256(enc.encode(serializeFiles(files))); }
export async function tokenHash(token) { return await sha256(enc.encode(token)); }
export function now() {return new Date().toISOString();}
export function randomId(prefix='') { const b=crypto.getRandomValues(new Uint8Array(24)); return prefix+Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }
