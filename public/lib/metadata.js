import {problem as invalid,safeName as slug} from './policy.js';
export function frontmatter(md) {
  // Parse only required top-level scalars. Other standard/Hermes YAML fields are preserved untouched.
  const normalized = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw invalid('SKILL.md requires YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0 || end > 16_384) throw invalid('SKILL.md YAML frontmatter is incomplete');
  const lines=normalized.slice(4,end).split('\n');
  function scalar(key){
    const index=lines.findIndex(x=>x.startsWith(key+':'));
    if(index<0)return '';
    const text=lines[index].slice(key.length+1).trim();
    if(text==='>'||text==='>-'||text==='|'||text==='|-'){
      const continuation=[];
      for(let n=index+1;n<lines.length;n++){
        const line=lines[n];
        if(line.trim()===''){continuation.push('');continue;}
        if(!/^ +/.test(line))break;
        continuation.push(line.replace(/^ +/,''));
      }
      return (text.startsWith('>')?continuation.join(' ').replace(/\s+/g,' '):continuation.join('\n')).trim();
    }
    if(text.startsWith('"')&&text.endsWith('"')){
      try{return JSON.parse(text);}catch{throw invalid('Invalid YAML double-quoted scalar: '+key);}
    }
    if(text.startsWith("'")&&text.endsWith("'"))return text.slice(1,-1).replace(/''/g,"'");
    return text.replace(/\s+#.*$/, '').trim();
  }
  const name=slug(scalar('name'));
  const description=scalar('description');
  if(!description||description.length>1024)throw invalid('description must be 1–1024 characters');
  return {name,description};
}
