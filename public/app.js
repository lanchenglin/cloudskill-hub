import {unpack,verifyPackage,validatePackageManifest,boundedBytes} from './lib/archive.js';
import {validateEntries,HARD_LIMITS,MiB} from './lib/policy.js';
import {frontmatter} from './lib/metadata.js';
import {publishBrowser} from './lib/browser-upload.js';
const $ = id => document.getElementById(id);
const state = {token:sessionStorage.getItem('csh-token')||'',me:null,projects:[],skills:[],devices:[],view:'library'};
let toastTimer;
function toast(message,bad=false){const el=$('toast');el.textContent=message;el.className=bad?'bad':'';el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',4500);}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;}
async function api(path,method='GET',data){
  const res=await fetch(path,{method,headers:{'Accept':'application/json',...(state.token?{Authorization:'Bearer '+state.token}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,redirect:'error'});
  let reply;try{reply=await res.json();}catch{throw Error('服务器未返回 JSON');}
  if(!res.ok)throw Object.assign(Error(reply.error||`HTTP ${res.status}`),{status:res.status});return reply;
}
function authUi(active){$('auth-card').hidden=active;$('dashboard').hidden=!active;$('actor').textContent=state.me?.label||'未登录';$('role').textContent=state.me?.role==='admin'?'管理员':'只读客户端';document.querySelectorAll('[data-view="publish"],[data-view="security"]').forEach(el=>el.hidden=active&&state.me?.role!=='admin');if(active&&state.me?.role!=='admin'&&['publish','security'].includes(state.view))view('library');}
async function login(token){state.token=token.trim();state.me=await api('/api/me');sessionStorage.setItem('csh-token',state.token);authUi(true);await refresh();}
async function refresh(){const [projects,skills,cap]=await Promise.all([api('/api/projects'),api('/api/catalog'),api('/api/capabilities')]);state.capabilities=cap;showLimits(cap.limits);state.projects=projects.projects;state.skills=skills.skills;if(state.me.role==='admin'){try{state.devices=(await api('/api/devices')).devices;}catch{state.devices=[];}}render();}
function view(name){state.view=name;document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===name));document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+name);$('crumb').textContent={library:'技能仓库',publish:'发布技能',devices:'客户端设备',security:'访问权限'}[name]||name;if(name==='devices')renderDevices();if(name==='security')renderSecurity();}
function projectOptions(select,placeholder=false){const current=select.value;select.replaceChildren();if(placeholder){const opt=node('option',null,'全部项目');opt.value='';select.append(opt);}for(const p of state.projects){const opt=node('option',null,p.title+' · '+p.slug);opt.value=p.slug;select.append(opt);}if([...select.options].some(x=>x.value===current))select.value=current;}
function render(){ $('numSkills').textContent=state.skills.length;$('numProjects').textContent=state.projects.length;$('numDevices').textContent=state.me.role==='admin'?state.devices.length:'—';projectOptions($('projectFilter'),true);projectOptions($('publishProject'));renderSkills();renderDevices();renderSecurity();}
function renderSkills(){const q=$('search').value.trim().toLowerCase();const p=$('projectFilter').value;const skills=state.skills.filter(s=>(!p||s.project===p)&&`${s.slug} ${s.project} ${s.description}`.toLowerCase().includes(q));const grid=$('skillsGrid');grid.replaceChildren();if(!skills.length)return grid.append(node('div','empty','没有匹配的 Skill。可先创建项目，再发布 SKILL.md。'));
  for(const s of skills){const card=node('button','skill-card');const top=node('div','card-head');const glyph=node('div','glyph','✳');const visible=node('div','visibility'+(s.visibility==='public'?' public':''),s.visibility==='public'?'● 公开':'◌ 私有');top.append(glyph,visible);card.append(top,node('strong',null,s.slug),node('p',null,s.description));const foot=node('div','card-foot');foot.append(node('span',null,s.project),node('b',null,'v'+s.version+'  ↗'));card.append(foot);card.addEventListener('click',()=>details(s));grid.append(card);}}
async function binary(path,max){
  const response=await fetch(path,{headers:{Authorization:`Bearer ${state.token}`},redirect:'error'});
  if(!response.ok){let msg;try{msg=(await response.json()).error;}catch{}throw Error(msg||'读取文件失败');}
  if(Number(response.headers.get('content-length')||0)>max){await response.body.cancel();throw Error('文件超过安全读取上限');}
  return new Blob([await boundedBytes(response.body,max)]);
}
async function markdown(detail){
  if(detail.format===2)return (await binary(`/api/projects/${detail.project}/skills/${detail.slug}/versions/${detail.version}/file?path=SKILL.md`,HARD_LIMITS.maxSkillMdBytes)).text();
  return new TextDecoder().decode(Uint8Array.from(atob(detail.files['SKILL.md']),c=>c.charCodeAt(0)));
}
async function entriesOf(detail){
  if(detail.format===2){validatePackageManifest(detail.manifest);return verifyPackage(await binary(detail.downloadPath,detail.manifest.archiveBytes),detail.manifest);}
  return Object.entries(detail.files).map(([name,data])=>({name,blob:new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))]),mode:420}));
}
async function details(s){
  const dialog=$('detailDialog'),body=$('detailBody');body.replaceChildren(node('h2',null,s.slug),node('p','detail-meta',`${s.project} · ${s.visibility==='public'?'公开':'私有'} · v${s.version}\n${s.description}`));dialog.showModal();
  try{
    const [detail,history]=await Promise.all([api(`/api/projects/${s.project}/skills/${s.slug}/versions/${s.version}?format=manifest`),api(`/api/projects/${s.project}/skills/${s.slug}/versions`)]);
    let active=detail;body.append(node('p','detail-meta',`cloudskill install ${s.project}/${s.slug} --agents claude,codex,hermes`));
    const label=node('p','detail-meta',`正在查看 v${detail.version}`),text=node('textarea');text.value=await markdown(detail);text.readOnly=state.me.role!=='admin';body.append(label,text);
    const actions=node('div','detail-actions');
    if(state.me.role==='admin'){
      const save=node('button','primary','保存为新版本');save.onclick=async()=>{
        if(activeUpload){toast('另一个上传正在进行',true);return;}
        const controller=new AbortController();activeUpload=controller;save.disabled=true;
        try{
          if(frontmatter(text.value).name!==s.slug)throw Error('编辑不能修改 Skill 名称；请另行发布新 Skill');
          const entries=await entriesOf(active),md=entries.find(e=>e.name==='SKILL.md');md.blob=new Blob([text.value]);
          const r=await publishBrowser({entries,limits:state.capabilities.limits,project:s.project,visibility:s.visibility,baseVersion:s.version,api,token:state.token,signal:controller.signal,progress:uploadProgress,pending,onPending:setPending});
          toast('已发布 v'+r.version);dialog.close();await refresh();
        }catch(e){toast(e.message,true);}finally{save.disabled=false;activeUpload=null;}
      };actions.append(save);
    }
    const download=node('button','secondary','下载此版本 ZIP');download.onclick=async()=>{try{
      const blob=await binary(`/api/projects/${s.project}/skills/${s.slug}/versions/${active.version}/download`,HARD_LIMITS.maxArchiveBytes),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=`${s.slug}-v${active.version}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){toast(e.message,true);}};actions.append(download);body.append(actions);
    const versions=node('div','versions');for(const v of history.versions){
      const btn=node('button',null,'查看 v'+v.version);btn.onclick=async()=>{try{active=await api(`/api/projects/${s.project}/skills/${s.slug}/versions/${v.version}?format=manifest`);text.value=await markdown(active);label.textContent='正在查看 v'+v.version+'；保存会保留此版本的其他文件。';}catch(e){toast(e.message,true);}};versions.append(btn);
      if(state.me.role==='admin'){const rollback=node('button',null,'回滚到 v'+v.version);rollback.onclick=async()=>{if(!confirm('将 v'+v.version+' 完整发布为新版本？'))return;try{const r=await api(`/api/projects/${s.project}/skills/${s.slug}/rollback`,'POST',{version:v.version,baseVersion:s.version});toast('已回滚为 v'+r.version);dialog.close();await refresh();}catch(e){toast(e.message,true);}};versions.append(rollback);}
    }body.append(node('h3',null,'历史版本'),versions);
  }catch(e){toast(e.message,true);}
}
let selectedFiles=[],pickGeneration=0,activeUpload=null,pending=null;
try{pending=JSON.parse(sessionStorage.getItem('csh-upload')||'null');}catch{}
function setPending(value){pending=value;value?sessionStorage.setItem('csh-upload',JSON.stringify(value)):sessionStorage.removeItem('csh-upload');$('pendingUpload').textContent=value?`待完成：${value.project}/${value.slug} · ${value.id}。选择相同源文件再次发布可复用会话。`:'';$('discardUpload').hidden=!value;}
function showLimits(l){$('uploadLimits').textContent=`单 Skill ≤ ${l.maxBundleBytes/MiB} MiB · 单文件 ≤ ${l.maxFileBytes/MiB} MiB · 最多 ${l.maxFiles} 文件 · 输入 ZIP ≤ ${l.maxArchiveBytes/MiB} MiB。根目录须有 SKILL.md（≤ ${l.maxSkillMdBytes/1024} KiB）。`;$('policyHelp').textContent='支持目录或 ZIP（STORE/DEFLATE）。一包一个 Skill；不接受加密包、ZIP64、软链接、隐藏配置或危险路径。';setPending(pending);}
function uploadProgress(e){
  const labels={hash:'正在计算校验',unzip:'正在检查 ZIP',upload:'正在上传',finalize:'校验完成，正在发布',session:'已建立上传会话'};
  $('uploadProgress').hidden=false;$('uploadProgress').max=e.total||1;$('uploadProgress').value=e.done||0;
  $('uploadStatus').textContent=(labels[e.phase]||e.phase)+(e.total?` · ${Math.round(e.done/e.total*100)}%`:'');
}
async function onPicked(ev,kind){
  const generation=++pickGeneration;selectedFiles=[];$('publishSubmit').disabled=true;
  try{
    const l=state.capabilities.limits;let entries;
    if(kind==='zip'){
      const file=ev.target.files[0];if(!file)return;
      const decoded=await unpack(file,l,{onProgress:uploadProgress});entries=decoded.entries;
      if(decoded.skipped.length)toast(`忽略 ${decoded.skipped.length} 个 macOS 元数据条目`);
    }else entries=[...ev.target.files].map(file=>({name:kind==='folder'?file.webkitRelativePath.split('/').slice(1).join('/'):file.name,blob:file,mode:420}));
    const bytes=validateEntries(entries.map(e=>({name:e.name,size:e.blob.size})),l);
    frontmatter(await entries.find(e=>e.name==='SKILL.md').blob.text());
    if(generation!==pickGeneration)return;selectedFiles=entries;
    $('pickedFiles').textContent=`已选择 ${entries.length} 个文件 · ${(bytes/MiB).toFixed(2)} MiB · ${entries.slice(0,6).map(e=>e.name).join(', ')}${entries.length>6?' …':''}`;$('uploadStatus').textContent='预检查通过，尚未上传';
  }catch(e){if(generation===pickGeneration){selectedFiles=[];$('pickedFiles').textContent=e.message;toast(e.message,true);}}
  finally{if(generation===pickGeneration)$('publishSubmit').disabled=false;}
}
async function publish(ev){
  ev.preventDefault();if(activeUpload)return;
  const controller=new AbortController();activeUpload=controller;$('publishSubmit').disabled=true;$('cancelUpload').hidden=false;
  try{
    if(!selectedFiles.length)throw Error('请先选择 Skill 文件、目录或 ZIP');
    const project=$('publishProject').value;if(!project)throw Error('请先创建并选择项目');
    const name=frontmatter(await selectedFiles.find(e=>e.name==='SKILL.md').blob.text()).name;
    const latest=state.skills.find(s=>s.project===project&&s.slug===name);
    const r=await publishBrowser({entries:selectedFiles,limits:state.capabilities.limits,project,visibility:$('makePublic').checked?'public':'private',baseVersion:latest?.version??0,api,token:state.token,signal:controller.signal,progress:uploadProgress,pending,onPending:setPending});
    toast(r.unchanged?'内容未变化，未新增版本':'发布成功 v'+r.version);selectedFiles=[];$('pickedFiles').textContent='尚未选择文件';$('publishForm').reset();$('uploadStatus').textContent='发布完成';await refresh();view('library');
  }catch(e){$('uploadStatus').textContent=e.message;toast(e.message,true);}
  finally{activeUpload=null;$('publishSubmit').disabled=false;$('cancelUpload').hidden=true;}
}
$('cancelUpload').onclick=()=>activeUpload?.abort();
$('discardUpload').onclick=async()=>{if(!pending||!confirm('放弃这个尚未发布的上传会话？'))return;try{await api(`/api/uploads/${pending.id}`,'DELETE');setPending(null);toast('已取消上传会话');}catch(e){if([404,409,410].includes(e.status))setPending(null);toast(e.message,true);}};
function renderDevices(){const root=$('deviceList');root.replaceChildren();if(!state.me||state.me.role!=='admin')return root.append(node('div','empty','只有管理员可以查看设备登记记录。'));if(!state.devices.length)return root.append(node('div','empty','暂无设备；运行 cloudskill status 或 sync 后会在这里出现。'));
 for(const d of state.devices){let installs=[];try{installs=JSON.parse(d.installs);}catch{}const stale=installs.filter(item=>{const latest=state.skills.find(s=>s.project===item.project&&s.slug===item.slug);return latest&&latest.digest!==item.digest;}).length;
  const container=node('div','device-item');const row=node('div','row-card');const info=node('div');
  info.append(node('b',null,d.device_name),node('small',null,`${d.os} · ${d.token_label} · ${installs.length} 个安装条目 · ${stale} 个待更新 · ${d.last_seen_at}`));row.append(info);container.append(row);
  if(installs.length){const details=node('details','device-details'),summary=node('summary',null,'查看设备安装清单');details.append(summary);
    for(const item of installs){const latest=state.skills.find(s=>s.project===item.project&&s.slug===item.slug);details.append(node('div','device-skill',`${item.agent||'agent'} · ${item.project}/${item.slug} · v${item.version} ${latest&&latest.digest!==item.digest?'· 有更新':'· 已同步'}`));}
    container.append(details);}
  root.append(container);
 }}
function renderSecurity(){const scope=$('tokenScope');scope.replaceChildren();for(const p of state.projects){const label=node('label');const input=node('input');input.type='checkbox';input.value=p.slug;label.append(input,node('span',null,p.title));scope.append(label);}if(state.me?.role==='admin')refreshTokens();}
async function refreshTokens(){try{const items=(await api('/api/tokens')).tokens;const root=$('tokensList');root.replaceChildren();for(const t of items){const row=node('div','row-card'),info=node('div');info.append(node('b',null,t.label),node('small',null,t.role+' · '+(t.revoked_at?'已撤销':'有效')+' · '+t.created_at));row.append(info);if(!t.revoked_at){const btn=node('button',null,'撤销');btn.onclick=async()=>{if(!confirm(`撤销 ${t.label}？`))return;try{await api(`/api/tokens/${t.id}/revoke`,'POST',{});await refreshTokens();toast('令牌已撤销');}catch(e){toast(e.message,true);}};row.append(btn);}root.append(row);}}catch(e){toast(e.message,true);}}
async function issue(ev){ev.preventDefault();try{const role=$('tokenRole').value;const projects=[...$('tokenScope').querySelectorAll('input:checked')].map(x=>x.value);const result=await api('/api/tokens','POST',{label:$('tokenLabel').value,role,projects});$('issuedValue').textContent=result.token;$('issuedToken').hidden=false;await refreshTokens();toast('令牌已生成，请立即复制');}catch(e){toast(e.message,true);}}
async function newProject(ev){ev.preventDefault();try{await api('/api/projects','POST',{slug:$('newProjectSlug').value,title:$('newProjectTitle').value});$('projectForm').reset();toast('项目已创建');await refresh();}catch(e){toast(e.message,true);}}
document.querySelectorAll('.nav-item').forEach(el=>el.addEventListener('click',()=>view(el.dataset.view)));
document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>view(el.dataset.go)));
$('logout').onclick=()=>{state.token='';state.me=null;sessionStorage.removeItem('csh-token');authUi(false);};
$('authBtn').onclick=async()=>{try{await login($('tokenInput').value);toast('已连接私人 Hub');}catch(e){toast(e.message,true);}};
$('setupBtn').onclick=async()=>{try{const response=await api('/api/bootstrap','POST',{secret:$('setupSecret').value,label:'Owner'});await login(response.token);$('issuedValue').textContent=response.token;$('issuedToken').hidden=false;view('security');toast('初始化成功：请立即保存管理员令牌');}catch(e){toast(e.message,true);}};
$('search').oninput=renderSkills;$('projectFilter').onchange=renderSkills;
$('skillFile').onchange=e=>onPicked(e,'file');$('skillFolder').onchange=e=>onPicked(e,'folder');$('skillZip').onchange=e=>onPicked(e,'zip');
$('publishForm').onsubmit=publish;$('tokenForm').onsubmit=issue;$('projectForm').onsubmit=newProject;
$('copyIssued').onclick=()=>navigator.clipboard.writeText($('issuedValue').textContent).then(()=>toast('已复制到剪贴板')).catch(()=>toast('请手动复制令牌',true));
if(state.token)login(state.token).catch(()=>{sessionStorage.removeItem('csh-token');state.token='';authUi(false);});else authUi(false);
