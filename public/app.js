import {unpack,verifyPackage,validatePackageManifest,boundedBytes} from './lib/archive.js';
import {validateEntries,HARD_LIMITS,MiB} from './lib/policy.js';
import {frontmatter} from './lib/metadata.js';
import {publishBrowser} from './lib/browser-upload.js';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH,validatePassword,validateNewPassword} from './lib/password-policy.js';
const $ = id => document.getElementById(id);
function passwordInputs(formId,firstId,againId,initial=false){
  const first=$(firstId),again=$(againId),validate=initial?validatePassword:validateNewPassword;
  function refresh(){
    for(const input of [first,again]){
      // HTML maxlength counts UTF-16 units. Allow room for 20 supplementary characters;
      // this shared code-point check is the actual 6–20 constraint and never truncates input.
      input.minLength=MIN_PASSWORD_LENGTH;input.maxLength=MAX_PASSWORD_LENGTH*2;
      let message='';
      if(input.value){try{validate(input.value);}catch(error){message=error.message.includes('6–20')?'密码须为 6～20 个字符':'新密码不能使用公开的初始密码';}}
      input.setCustomValidity(message);
    }
    if(!again.validationMessage&&again.value&&first.value!==again.value)again.setCustomValidity('两次输入的密码不一致');
  }
  first.addEventListener('input',refresh);again.addEventListener('input',refresh);
  $(formId).addEventListener('reset',()=>queueMicrotask(refresh));refresh();
}
passwordInputs('setupForm','setupPassword','setupPasswordAgain',true);
passwordInputs('forcePasswordForm','forceNewPassword','forceNewPasswordAgain');
passwordInputs('passwordForm','newPassword','newPasswordAgain');

sessionStorage.removeItem('csh-token'); // Retire old long-lived browser API credentials.
const state = {csrfToken:'',me:null,projects:[],skills:[],devices:[],view:'library',authStatus:null,mustChangePassword:false};
let toastTimer;
function toast(message,bad=false){const el=$('toast');el.textContent=message;el.className=bad?'bad':'';el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',4500);}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;}
async function api(path,method='GET',data,extraHeaders={}){
  const headers={'Accept':'application/json','X-CloudSkill-Request':'1',...(data?{'Content-Type':'application/json'}:{}),...extraHeaders};
  if(!['GET','HEAD'].includes(method)&&state.csrfToken)headers['X-CSRF-Token']=state.csrfToken;
  const res=await fetch(path,{method,credentials:'same-origin',headers,body:data?JSON.stringify(data):undefined,redirect:'error'});
  let reply;try{reply=await res.json();}catch{throw Error('服务器未返回 JSON');}
  if(!res.ok){
    if(res.status===401&&!path.startsWith('/api/auth/'))clearLogin();
    if(reply.error==='password_change_required'&&state.me){state.mustChangePassword=true;authUi(true);}
    const hint=res.status===429?'尝试过于频繁，请稍后再试（服务器已限速）':reply.error||`HTTP ${res.status}`;
    throw Object.assign(Error(hint),{status:res.status});
  }
  return reply;
}
function authUi(active){
  const restricted=active&&state.mustChangePassword;
  $('auth-card').hidden=active;$('dashboard').hidden=!active||restricted;$('forcePasswordPanel').hidden=!restricted;
  $('actor').textContent=state.me?.label||'未登录';$('role').textContent=restricted?'必须先修改初始密码':active?'网页管理员':'账号密码登录';
  $('logout').hidden=!active;
  document.querySelectorAll('.nav-item,[data-go]').forEach(el=>el.disabled=!active||restricted);
}
function clearLogin(){
  activeUpload?.abort();selectedFiles=[];pickGeneration++;
  if($('detailDialog').open)$('detailDialog').close();$('detailBody').replaceChildren();
  state.csrfToken='';state.me=null;state.mustChangePassword=false;$('forcePasswordForm').reset();$('forcePasswordError').textContent='';state.skills=[];state.projects=[];state.devices=[];
  $('issuedValue').textContent='';$('issuedToken').hidden=true;$('passwordForm').reset();
  $('skillsGrid').replaceChildren();$('tokensList').replaceChildren();authUi(false);
}
async function acceptSession(session){
  state.csrfToken=session.csrfToken;state.me={label:session.username,role:'admin'};
  state.mustChangePassword=Boolean(session.mustChangePassword);
  authUi(true);if(state.mustChangePassword){$('forceNewPassword').focus();return;}
  await refresh();
}
async function login(username,password){
  const session=await api('/api/auth/login','POST',{username,password});
  await acceptSession(session);
  if(state.mustChangePassword)$('forceCurrentPassword').value=password;
}
async function loadAuthStatus(){
  const status=await api('/api/auth/status');state.authStatus=status;
  $('setupPanel').hidden=status.initialized||!status.setupEnabled;
  $('setupSecret').hidden=status.legacyConversion;
  document.querySelector('label[for="setupSecret"]').hidden=status.legacyConversion;
  $('legacyAdminToken').hidden=!status.legacyConversion;$('legacyTokenLabel').hidden=!status.legacyConversion;
  if(status.legacyConversion)$('setupHelp').textContent='已有 Token 模式实例：用原管理员 Token 设置网页账号。只读 / 发布令牌不能执行此转换。';
}
let reauthPromise=null;
function reauthenticate(){
  if(reauthPromise)return reauthPromise;
  reauthPromise=new Promise((resolve,reject)=>{
    const dialog=$('reauthDialog');$('reauthForm').reset();$('reauthError').textContent='';
    const finish=(error)=>{dialog.close();$('reauthForm').reset();reauthPromise=null;error?reject(error):resolve();};
    $('cancelReauth').onclick=()=>finish(Error('已取消敏感操作'));
    dialog.oncancel=e=>{e.preventDefault();finish(Error('已取消敏感操作'));};
    $('reauthForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/auth/reauth','POST',{password:$('reauthPassword').value});finish();}catch(error){$('reauthError').textContent=error.message;$('reauthPassword').value='';}};
    dialog.showModal();$('reauthPassword').focus();
  });return reauthPromise;
}
async function sensitiveApi(path,method,data){
  try{return await api(path,method,data);}catch(error){
    if(error.message!=='reauth_required')throw error;
    await reauthenticate();return api(path,method,data);
  }
}
async function refresh(){const [projects,skills,cap]=await Promise.all([api('/api/projects'),api('/api/catalog'),api('/api/capabilities')]);state.capabilities=cap;showLimits(cap.limits);state.projects=projects.projects;state.skills=skills.skills;if(state.me.role==='admin'){try{state.devices=(await api('/api/devices')).devices;}catch{state.devices=[];}}render();}
function view(name){if(!state.me||state.mustChangePassword)return;state.view=name;document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===name));document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+name);$('crumb').textContent={library:'技能仓库',publish:'发布技能',devices:'客户端设备',security:'访问权限'}[name]||name;if(name==='devices')renderDevices();if(name==='security')renderSecurity();}
function projectOptions(select,placeholder=false){const current=select.value;select.replaceChildren();if(placeholder){const opt=node('option',null,'全部项目');opt.value='';select.append(opt);}for(const p of state.projects){const opt=node('option',null,p.title+' · '+p.slug);opt.value=p.slug;select.append(opt);}if([...select.options].some(x=>x.value===current))select.value=current;}
function render(){ $('numSkills').textContent=state.skills.length;$('numProjects').textContent=state.projects.length;$('numDevices').textContent=state.me.role==='admin'?state.devices.length:'—';projectOptions($('projectFilter'),true);projectOptions($('publishProject'));renderSkills();renderDevices();renderSecurity();}
function renderSkills(){const q=$('search').value.trim().toLowerCase();const p=$('projectFilter').value;const skills=state.skills.filter(s=>(!p||s.project===p)&&`${s.slug} ${s.project} ${s.description}`.toLowerCase().includes(q));const grid=$('skillsGrid');grid.replaceChildren();if(!skills.length)return grid.append(node('div','empty','没有匹配的 Skill。可先创建项目，再发布 SKILL.md。'));
  for(const s of skills){const card=node('button','skill-card');const top=node('div','card-head');const glyph=node('div','glyph','✳');const visible=node('div','visibility'+(s.visibility==='public'?' public':''),s.visibility==='public'?'● 共享':'◌ 私有');top.append(glyph,visible);card.append(top,node('strong',null,s.slug),node('p',null,s.description));const foot=node('div','card-foot');foot.append(node('span',null,s.project),node('b',null,'v'+s.version+'  ↗'));card.append(foot);card.addEventListener('click',()=>details(s));grid.append(card);}}
async function binary(path,max){
  const response=await fetch(path,{credentials:'same-origin',redirect:'error'});
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
  const dialog=$('detailDialog'),body=$('detailBody');body.replaceChildren(node('h2',null,s.slug),node('p','detail-meta',`${s.project} · ${s.visibility==='public'?'共享':'私有'} · v${s.version}\n${s.description}`));dialog.showModal();
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
          const r=await publishBrowser({entries,limits:state.capabilities.limits,project:s.project,visibility:s.visibility,baseVersion:s.version,api,csrfToken:state.csrfToken,signal:controller.signal,progress:uploadProgress,pending,onPending:setPending});
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
    const r=await publishBrowser({entries:selectedFiles,limits:state.capabilities.limits,project,visibility:$('makePublic').checked?'public':'private',baseVersion:latest?.version??0,api,csrfToken:state.csrfToken,signal:controller.signal,progress:uploadProgress,pending,onPending:setPending});
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
function renderSecurity(){if(state.me?.role==='admin')refreshTokens();}
async function refreshTokens(){try{const items=(await api('/api/tokens')).tokens;const root=$('tokensList');root.replaceChildren();for(const t of items){const row=node('div','row-card'),info=node('div');info.append(node('b',null,t.label),node('small',null,({shared_writer:'修改共享技能',all_writer:'修改全部技能',client:'旧只读令牌',publisher:'旧项目发布令牌',admin:'旧管理员 API'}[t.role]||t.role)+' · '+(t.revoked_at?'已撤销':t.expires_at&&Date.parse(t.expires_at)<=Date.now()?'已过期':'有效')+(t.permission_mode==='legacy'?' · 旧项目范围 '+t.project_scope:'')+' · 有效期 '+(t.expires_at===null?'永久有效（可手动撤销）':t.expires_at||'未知，请核实')));row.append(info);if(!t.revoked_at){const btn=node('button',null,'撤销');btn.onclick=async()=>{if(!confirm(`撤销 ${t.label}？`))return;try{await sensitiveApi(`/api/tokens/${t.id}/revoke`,'POST',{});await refreshTokens();toast('令牌已撤销');}catch(e){toast(e.message,true);}};row.append(btn);}root.append(row);}}catch(e){toast(e.message,true);}}
async function issue(ev){ev.preventDefault();try{const role=$('tokenRole').value;const result=await sensitiveApi('/api/tokens','POST',{label:$('tokenLabel').value,role,expiresInDays:$('tokenDays').value==='never'?null:Number($('tokenDays').value)});$('issuedValue').textContent=result.token;$('issuedToken').hidden=false;await refreshTokens();toast('令牌已生成，请立即复制');}catch(e){toast(e.message,true);}}
async function newProject(ev){ev.preventDefault();try{await api('/api/projects','POST',{slug:$('newProjectSlug').value,title:$('newProjectTitle').value});$('projectForm').reset();toast('项目已创建');await refresh();}catch(e){toast(e.message,true);}}
document.querySelectorAll('.nav-item').forEach(el=>el.addEventListener('click',()=>view(el.dataset.view)));
document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>view(el.dataset.go)));
$('logout').onclick=async()=>{
  activeUpload?.abort();try{await api('/api/auth/logout','POST',{});clearLogin();await loadAuthStatus();toast('已退出，当前会话已失效');}catch(e){toast(e.message,true);}
};
$('loginForm').onsubmit=async e=>{
  e.preventDefault();$('authBtn').disabled=true;$('authError').textContent='';
  try{await login($('usernameInput').value,$('passwordInput').value);$('passwordInput').value='';toast('登录成功');}
  catch(error){$('authError').textContent=error.message;$('passwordInput').value='';}
  finally{$('authBtn').disabled=false;}
};
$('setupForm').onsubmit=async e=>{
  e.preventDefault();$('setupBtn').disabled=true;
  try{
    const username=$('setupUsername').value,password=validatePassword($('setupPassword').value);
    if(password!==$('setupPasswordAgain').value)throw Error('两次输入的密码不一致');
    const headers=state.authStatus?.legacyConversion?{Authorization:'Bearer '+$('legacyAdminToken').value.trim()}:{};
    await api('/api/auth/setup','POST',{secret:$('setupSecret').value,username,password},headers);
    $('setupForm').reset();await login(username,password);
    await loadAuthStatus();toast('管理员已初始化，请先修改初始密码');
  }catch(error){toast(error.message,true);}finally{$('setupBtn').disabled=false;}
};
$('forceLogout').onclick=()=>$('logout').click();
$('forcePasswordForm').onsubmit=async e=>{
  e.preventDefault();$('forcePasswordSubmit').disabled=true;$('forcePasswordError').textContent='';
  try{
    if($('forceNewPassword').value!==$('forceNewPasswordAgain').value)throw Error('两次输入的新密码不一致');
    const username=state.me.label;
    await api('/api/auth/password','POST',{currentPassword:$('forceCurrentPassword').value,newPassword:validateNewPassword($('forceNewPassword').value)});
    clearLogin();$('usernameInput').value=username;toast('初始密码已修改，请使用新密码重新登录');
  }catch(error){
    $('forcePasswordError').textContent=error.message;
  }finally{$('forcePasswordSubmit').disabled=false;}
};
$('passwordForm').onsubmit=async e=>{
  e.preventDefault();const button=e.target.querySelector('button[type="submit"]');button.disabled=true;
  try{
    if($('newPassword').value!==$('newPasswordAgain').value)throw Error('两次输入的新密码不一致');
    await api('/api/auth/password','POST',{currentPassword:$('currentPassword').value,newPassword:validateNewPassword($('newPassword').value)});
    clearLogin();toast('密码已修改，所有网页会话已退出；客户端 Token 保持有效');
  }catch(error){toast(error.message,true);}finally{button.disabled=false;}
};
$('revokeAllTokens').onclick=async()=>{
  if(!confirm('撤销所有 API 令牌？A、B 等客户端之后都需要重新配置。已下载的文件不会被收回。'))return;
  try{await sensitiveApi('/api/auth/revoke-all-tokens','POST',{confirm:'revoke-all-api-tokens'});$('issuedToken').hidden=true;$('issuedValue').textContent='';await refreshTokens();toast('全部 API 令牌已撤销');}catch(error){toast(error.message,true);}
};
$('search').oninput=renderSkills;$('projectFilter').onchange=renderSkills;
$('skillFile').onchange=e=>onPicked(e,'file');$('skillFolder').onchange=e=>onPicked(e,'folder');$('skillZip').onchange=e=>onPicked(e,'zip');
$('publishForm').onsubmit=publish;$('tokenForm').onsubmit=issue;$('projectForm').onsubmit=newProject;
$('copyIssued').onclick=()=>navigator.clipboard.writeText($('issuedValue').textContent).then(()=>toast('已复制到剪贴板')).catch(()=>toast('请手动复制令牌',true));
authUi(false);
(async()=>{try{await loadAuthStatus();try{await acceptSession(await api('/api/auth/session'));}catch(error){if(error.status!==401)throw error;}}catch(error){$('authError').textContent=error.message;}})();
