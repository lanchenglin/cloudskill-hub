/** Upload policy shared by Worker, browser and CLI. Values are bytes, not decimal MB. */
export const MiB = 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({maxFiles:1000, maxBundleBytes:50*MiB,
  maxFileBytes:20*MiB, maxArchiveBytes:55*MiB, maxSkillMdBytes:256*1024,
  maxPathBytes:256, maxDepth:16, maxCompressionRatio:200});
export const HARD_LIMITS = Object.freeze({...DEFAULT_LIMITS, maxFiles:2000,
  maxBundleBytes:64*MiB, maxFileBytes:32*MiB, maxArchiveBytes:70*MiB});
export function problem(message, status=400) {return Object.assign(new Error(message), {status});}
export function resolveLimits(env={}) {
  const values={...DEFAULT_LIMITS};
  const bindings={MAX_SKILL_FILES:'maxFiles',MAX_SKILL_BYTES:'maxBundleBytes',MAX_FILE_BYTES:'maxFileBytes',MAX_ARCHIVE_BYTES:'maxArchiveBytes'};
  for(const [key,name] of Object.entries(bindings)) if(env[key]!==undefined && env[key]!=='') {
    const n=Number(env[key]);
    if(!Number.isSafeInteger(n)||n<1||n>HARD_LIMITS[name]) throw problem(`Invalid ${key}: expected 1–${HARD_LIMITS[name]}`,503);
    values[name]=n;
  }
  if(values.maxFileBytes>values.maxBundleBytes || values.maxBundleBytes>values.maxArchiveBytes)
    throw problem('Upload limits must satisfy file <= bundle <= archive',503);
  return values;
}
export function safeName(name) {
  if(typeof name!=='string'||name.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw problem('Invalid Skill name (lowercase letters, numbers, hyphens; 1–64 characters)');
  return name;
}
export function safeFilePath(value,limits=DEFAULT_LIMITS) {
  if(typeof value!=='string'||!value||new TextEncoder().encode(value).length>limits.maxPathBytes ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(value)||value.normalize('NFC')!==value) throw problem('Unsafe filename: '+String(value));
  const parts=value.split('/');
  if(parts.length>limits.maxDepth || parts.some(p=>!p||p.startsWith('.')||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p.normalize('NFKC'))))
    throw problem('Unsafe path segment: '+value);
  return value;
}
export function validateEntries(entries,limits=DEFAULT_LIMITS) {
  if(!Array.isArray(entries)||!entries.length||entries.length>limits.maxFiles) throw problem(`Expected 1–${limits.maxFiles} files`,413);
  const seen=new Set();let total=0;
  for(const e of entries) {
    if(!e||typeof e!=='object'||Array.isArray(e))throw problem('Invalid file descriptor');
    safeFilePath(e.name,limits);
    const key=e.name.normalize('NFKC').toLowerCase();
    if(seen.has(key)) throw problem('Duplicate/case-colliding filename: '+e.name);
    seen.add(key);
    if(!Number.isSafeInteger(e.size)||e.size<0||e.size>limits.maxFileBytes) throw problem(`File exceeds ${limits.maxFileBytes} bytes: ${e.name}`,413);
    total+=e.size;
    if(total>limits.maxBundleBytes) throw problem(`Skill exceeds ${limits.maxBundleBytes} bytes`,413);
    if(e.name==='SKILL.md'&&e.size>limits.maxSkillMdBytes) throw problem(`SKILL.md exceeds ${limits.maxSkillMdBytes} bytes`,413);
  }
  if(!entries.some(e=>e.name==='SKILL.md')) throw problem('Root SKILL.md is required (one Skill per upload)');
  for(const name of seen) {const parts=name.split('/');parts.pop();while(parts.length){if(seen.has(parts.join('/')))throw problem('File/directory path collision: '+name);parts.pop();}}
  return total;
}
