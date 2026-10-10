/** Public, read-only browsing. This page never sends saved credentials. */
const $=id=>document.getElementById(id);
let skills=[];
$('sharedCommands').textContent=`cloudskill connect ${location.origin}\ncloudskill list\ncloudskill install <项目>/<技能> --agents hermes\ncloudskill update`;
async function json(route){
  const r=await fetch(route,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(`共享内容暂不可用（HTTP ${r.status}）`);
  return r.json();
}
function element(tag,text,className){const e=document.createElement(tag);e.textContent=text;if(className)e.className=className;return e;}
function render(){
  const q=$('sharedSearch').value.trim().toLowerCase(),items=skills.filter(s=>`${s.project} ${s.slug} ${s.description}`.toLowerCase().includes(q));
  $('sharedGrid').replaceChildren();$('sharedStatus').textContent=items.length?`${items.length} 个共享技能`:'暂时没有匹配的共享技能';
  for(const s of items){
    const card=element('button','','skill-card');card.append(element('strong',s.slug),element('p',s.description),element('small',`${s.project} · v${s.version} · 共享`));
    card.addEventListener('click',()=>show(s));$('sharedGrid').append(card);
  }
}
async function show(s){
  const endpoint=`/api/public/projects/${encodeURIComponent(s.project)}/skills/${encodeURIComponent(s.slug)}/versions/${s.version}`;
  $('sharedTitle').textContent=s.slug;$('sharedText').textContent='正在读取…';$('sharedDownload').hidden=true;$('sharedDialog').showModal();
  try{
    const r=await fetch(endpoint+'/file?path=SKILL.md',{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error(`该技能已变更或不再共享（HTTP ${r.status}）`);
    // Skill content is untrusted text, never HTML or executable markdown.
    $('sharedText').textContent=await r.text();$('sharedDownload').href=endpoint+'/download';$('sharedDownload').hidden=false;
  }catch(e){$('sharedText').textContent=e.message;}
}
$('sharedSearch').addEventListener('input',render);
json('/api/public/catalog').then(r=>{skills=r.skills;render();}).catch(e=>$('sharedStatus').textContent=e.message);
