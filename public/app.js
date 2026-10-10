import {unpack,verifyPackage,validatePackageManifest,boundedBytes} from './lib/archive.js';
import {validateEntries,HARD_LIMITS,MiB} from './lib/policy.js';
import {frontmatter} from './lib/metadata.js';
import {publishBrowser} from './lib/browser-upload.js';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH,validatePassword,validateNewPassword} from './lib/password-policy.js';
import {TOKEN_ROLES,STATUS_LABELS,tokenStatus,tokenSummary,filterTokens,displayDate,tokenLifetime} from './lib/access-ui.js';
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
let toastTimer,sessionGeneration=0,loggingOut=false;
const VIEW_TITLES={library:'技能仓库',publish:'发布技能',projects:'项目分类',devices:'客户端设备',security:'访问权限',account:'账号设置'};
state.tokens=[];state.tokenStorageReady=false;
function toast(message,bad=false){const el=$('toast');el.textContent=message;el.className=bad?'bad':'';el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',4500);}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;}
async function api(path,method='GET',data,extraHeaders={}){
  const headers={'Accept':'application/json','X-CloudSkill-Request':'1',...(data?{'Content-Type':'application/json'}:{}),...extraHeaders};
  if(!['GET','HEAD'].includes(method)&&state.csrfToken)headers['X-CSRF-Token']=state.csrfToken;
  const generation=sessionGeneration;
  const res=await fetch(path,{method,credentials:'same-origin',headers,body:data?JSON.stringify(data):undefined,redirect:'error'});
  let reply;try{reply=await res.json();}catch{throw Error('服务器未返回 JSON');}
  if(generation!==sessionGeneration&&!path.startsWith('/api/auth/'))throw Object.assign(Error('登录状态已改变，请重新操作'),{name:'AbortError'});
  if(!res.ok){
    if(res.status===401&&!path.startsWith('/api/auth/'))clearLogin();
    if(reply.error==='password_change_required'&&state.me){state.mustChangePassword=true;authUi(true);}
    const hint=res.status===429?'尝试过于频繁，请稍后再试（服务器已限速）':reply.error||`HTTP ${res.status}`;
    const tokenHints={token_key_unavailable:'令牌加密密钥尚未配置或格式不正确，请按部署说明设置 TOKEN_ENCRYPTION_KEY。',token_decryption_failed:'无法解密此令牌，请恢复原 TOKEN_ENCRYPTION_KEY；不要重新生成密钥覆盖。',token_value_unavailable:'旧令牌只保存了哈希，无法还原；原令牌仍可使用，需要可查看的令牌请重新签发。'};
    throw Object.assign(Error(tokenHints[reply.error]||hint),{status:res.status});
  }
  return reply;
}
function authUi(active){
  const restricted=active&&state.mustChangePassword;
  $('auth-card').hidden=active;$('dashboard').hidden=!active||restricted;$('forcePasswordPanel').hidden=!restricted;
  $('actor').textContent=state.me?.label||'未登录';$('role').textContent=restricted?'必须先修改初始密码':active?'网页管理员':'账号密码登录';
  $('sessionControls').hidden=!active;$('logout').hidden=!active;
  $('accountName').textContent=state.me?.label||'';
  if(!active)$('crumb').textContent='登录';
  document.querySelectorAll('.nav-item,[data-go]').forEach(el=>el.disabled=!active||restricted);
}
function clearLogin(){
  sessionGeneration++;clearVisibleTokens();
  state.tokens=[];state.tokenStorageReady=false;state.view='library';
  $('tokenSearch').value='';$('tokenRoleFilter').value='';$('tokenStatusFilter').value='';
  $('tokenTotal').textContent='0';$('tokenSummary').textContent='';$('tokenFilteredCount').textContent='';
  $('projectList').replaceChildren();$('projectForm').reset();$('projectCount').textContent='0';
  $('tokenCreateError').textContent='';$('tokenCreateError').hidden=true;
  $('tokenListError').textContent='';$('tokenListError').hidden=true;
  $('accountName').textContent='';$('tokenForm').reset();
  if($('reauthDialog').open)$('cancelReauth').click();
  activeUpload?.abort();selectedFiles=[];pickGeneration++;
  if($('detailDialog').open)$('detailDialog').close();$('detailBody').replaceChildren();
  state.csrfToken='';state.me=null;state.mustChangePassword=false;$('forcePasswordForm').reset();$('forcePasswordError').textContent='';state.skills=[];state.projects=[];state.devices=[];
  $('issuedValue').textContent='';$('issuedToken').hidden=true;$('passwordForm').reset();
  $('skillsGrid').replaceChildren();$('tokensList').replaceChildren();authUi(false);
}
async function acceptSession(session){
  sessionGeneration++;state.csrfToken=session.csrfToken;state.me={label:session.username,role:'admin'};
  state.mustChangePassword=Boolean(session.mustChangePassword);
  authUi(true);if(state.mustChangePassword){$('forceNewPassword').focus();return;}
  await refresh();view(state.view);
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
async function refresh(){
  const identity=state.me,generation=sessionGeneration;if(!identity||loggingOut||state.mustChangePassword)return;
  const [projects,skills,cap]=await Promise.all([api('/api/projects'),api('/api/catalog'),api('/api/capabilities')]);
  if(identity!==state.me||generation!==sessionGeneration||loggingOut)return;
  state.capabilities=cap;showLimits(cap.limits);state.projects=projects.projects;state.skills=skills.skills;
  let devices=[];try{devices=(await api('/api/devices')).devices;}catch{}
  if(identity!==state.me||generation!==sessionGeneration||loggingOut)return;
  state.devices=devices;render();
}
function view(name){
  if(!state.me||state.mustChangePassword||loggingOut||!Object.hasOwn(VIEW_TITLES,name))return;
  if(name!=='security')clearVisibleTokens();
  const changed=state.view!==name;state.view=name;
  document.querySelectorAll('.nav-item').forEach(el=>{const active=el.dataset.view===name;el.classList.toggle('active',active);active?el.setAttribute('aria-current','page'):el.removeAttribute('aria-current');});
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+name);$('crumb').textContent=VIEW_TITLES[name];
  if(name==='devices')renderDevices();if(name==='projects')renderProjects();if(name==='security')renderSecurity();
  if(changed)window.scrollTo({top:0,behavior:'instant'});
}
function renderProjects(){
  const root=$('projectList');root.replaceChildren();$('projectCount').textContent=state.projects.length;
  if(!state.projects.length)return root.append(node('div','empty','暂无分类。创建分类后，即可上传并整理技能。'));
  for(const project of state.projects){
    const row=node('div','row-card project-row'),info=node('div');info.append(node('b',null,project.title),node('code','project-id',project.slug));
    const count=state.skills.filter(s=>s.project===project.slug).length;
    row.append(info,node('span','count-badge',count+' 个技能'));root.append(row);
  }
}
function projectOptions(select,placeholder=false){const current=select.value;select.replaceChildren();if(placeholder){const opt=node('option',null,'全部项目');opt.value='';select.append(opt);}for(const p of state.projects){const opt=node('option',null,p.title+' · '+p.slug);opt.value=p.slug;select.append(opt);}if([...select.options].some(x=>x.value===current))select.value=current;}
function render(){ $('numSkills').textContent=state.skills.length;$('numProjects').textContent=state.projects.length;$('numDevices').textContent=state.me.role==='admin'?state.devices.length:'—';projectOptions($('projectFilter'),true);projectOptions($('publishProject'));renderSkills();renderDevices();renderProjects();if(state.view==='security')renderSecurity();}
function renderSkills(){const q=$('search').value.trim().toLowerCase();const p=$('projectFilter').value;const skills=state.skills.filter(s=>(!p||s.project===p)&&`${s.slug} ${s.project} ${s.description}`.toLowerCase().includes(q));const grid=$('skillsGrid');grid.replaceChildren();if(!skills.length)return grid.append(node('div','empty','没有匹配的 Skill。可先创建项目，再发布 SKILL.md。'));
  for(const s of skills){const card=node('button','skill-card');const top=node('div','card-head');const glyph=node('div','glyph','✳');const visible=node('div','visibility'+(s.visibility==='public'?' public':''),s.visibility==='public'?'● 共享':'◌ 私有');top.append(glyph,visible);card.append(top,node('strong',null,s.slug),node('p',null,s.description));const foot=node('div','card-foot');foot.append(node('span',null,s.project),node('b',null,'v'+s.version+'  ↗'));card.append(foot);card.addEventListener('click',()=>details(s));grid.append(card);}}
async function binary(path,max){
  const generation=sessionGeneration;
  const response=await fetch(path,{credentials:'same-origin',redirect:'error'});
  if(!response.ok){let msg;try{msg=(await response.json()).error;}catch{}throw Error(msg||'读取文件失败');}
  if(Number(response.headers.get('content-length')||0)>max){await response.body.cancel();throw Error('文件超过安全读取上限');}
  const bytes=await boundedBytes(response.body,max);
  if(generation!==sessionGeneration||!state.me||loggingOut)throw Object.assign(Error('登录状态已改变，已停止读取'),{name:'AbortError'});
  return new Blob([bytes]);
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
  const identity=state.me;
  const dialog=$('detailDialog'),body=$('detailBody');body.replaceChildren(node('h2',null,s.slug),node('p','detail-meta',`${s.project} · ${s.visibility==='public'?'共享':'私有'} · v${s.version}\n${s.description}`));dialog.showModal();
  try{
    const [detail,history]=await Promise.all([api(`/api/projects/${s.project}/skills/${s.slug}/versions/${s.version}?format=manifest`),api(`/api/projects/${s.project}/skills/${s.slug}/versions`)]);
    if(identity!==state.me||!dialog.open||loggingOut)return;
    let active=detail;body.append(node('p','detail-meta',`cloudskill install ${s.project}/${s.slug} --agents claude,codex,hermes`));
    const label=node('p','detail-meta',`正在查看 v${detail.version}`),text=node('textarea');text.value=await markdown(detail);if(identity!==state.me||!dialog.open||loggingOut)return;text.readOnly=state.me.role!=='admin';body.append(label,text);
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
// Secret values live only in the visible DOM, never in browser storage or list data.
let tokenUiGeneration=0,tokenListGeneration=0,revealSequence=0,revealTimer,issuedTimer;
function clearRevealedToken(){
  revealSequence++;clearTimeout(revealTimer);
  $('tokenRevealValue').textContent='';$('tokenRevealLabel').textContent='';$('tokenRevealStatus').textContent='';
  if($('tokenRevealDialog').open)$('tokenRevealDialog').close();
}
function clearIssuedToken(){clearTimeout(issuedTimer);$('issuedValue').textContent='';$('issuedToken').hidden=true;}
function clearVisibleTokens(){
  tokenUiGeneration++;tokenListGeneration++;clearRevealedToken();clearIssuedToken();
  if($('tokenCreateDialog').open)$('tokenCreateDialog').close();
}
async function showTokenValue(token){
  clearVisibleTokens();const generation=tokenUiGeneration,sequence=revealSequence;
  try{
    const result=await sensitiveApi(`/api/tokens/${token.id}/reveal`,'POST',{});
    // A request finishing after logout, navigation, hiding or another reveal must not redisplay it.
    if(generation!==tokenUiGeneration||sequence!==revealSequence||!state.me||state.mustChangePassword||state.view!=='security'||document.hidden)return;
    $('tokenRevealLabel').textContent=token.label;
    $('tokenRevealValue').textContent=result.token;
    $('tokenRevealStatus').textContent=result.active?'可复制到需要此权限的客户端。':'此令牌已过期或撤销，仅供核对，查看不会使其恢复有效。';
    $('tokenRevealDialog').showModal();revealTimer=setTimeout(clearRevealedToken,60000);
  }catch(error){if(generation===tokenUiGeneration&&state.me)toast(error.message,true);}
}
$('hideTokenValue').onclick=clearRevealedToken;
$('tokenRevealDialog').addEventListener('cancel',event=>{event.preventDefault();clearRevealedToken();});
$('tokenRevealDialog').addEventListener('close',()=>{if(!$('tokenRevealDialog').open&&$('tokenRevealValue').textContent)clearRevealedToken();});
$('hideIssued').onclick=clearIssuedToken;
$('copyTokenValue').onclick=async()=>{
  const value=$('tokenRevealValue').textContent;if(!value)return;
  try{await navigator.clipboard.writeText(value);toast('已复制到剪贴板');}catch{toast('浏览器不允许自动复制，请选中令牌手动复制',true);}
};
window.addEventListener('pagehide',clearVisibleTokens);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearVisibleTokens();});
let tokenIssuing=false;
function tokenFormHints(){
  $('tokenRoleHint').textContent=$('tokenRole').value==='all_writer'?'可读取、推送和修改全部共享与私有技能。含私人凭据，请只交给可信工具。':'只能读取、推送和修改共享技能，不能访问私有技能。';
  $('tokenDaysHint').textContent=$('tokenDays').value==='never'?'不自动到期；不再使用时可以随时撤销。':'到期后失效。可以选择永久有效，不影响网页登录会话。';
}
function openTokenCreate(){
  if(!state.me||state.mustChangePassword||loggingOut||state.view!=='security')return;
  clearVisibleTokens();$('tokenForm').reset();tokenFormHints();
  $('tokenCreateError').textContent='';$('tokenCreateError').hidden=true;
  if(!state.tokenStorageReady){$('tokenCreateError').textContent='令牌加密密钥未就绪，请先完成部署配置或刷新列表重试。';$('tokenCreateError').hidden=false;}
  $('tokenForm').querySelector('button[type="submit"]').disabled=!state.tokenStorageReady||tokenIssuing;
  $('tokenCreateDialog').showModal();$('tokenLabel').focus();
}
$('openTokenCreate').onclick=openTokenCreate;
$('closeTokenCreate').onclick=clearVisibleTokens;
$('tokenCreateDialog').addEventListener('cancel',event=>{event.preventDefault();clearVisibleTokens();});
$('tokenCreateDialog').addEventListener('close',()=>{if(!$('tokenCreateDialog').open){tokenUiGeneration++;clearIssuedToken();}});
$('tokenRole').onchange=tokenFormHints;$('tokenDays').onchange=tokenFormHints;
function renderSecurity(){if(state.me?.role==='admin'&&state.view==='security')refreshTokens();}
function renderTokenList(){
  const tokens=state.tokens||[],summary=tokenSummary(tokens),root=$('tokensList');root.replaceChildren();
  $('tokenTotal').textContent=summary.total;
  $('tokenSummary').textContent=`${summary.active} 枚有效 · ${summary.expired} 枚已过期 · ${summary.revoked} 枚已撤销`+(summary.unknown?` · ${summary.unknown} 枚待核实`:'');
  const items=filterTokens(tokens,{query:$('tokenSearch').value,role:$('tokenRoleFilter').value,status:$('tokenStatusFilter').value});
  $('tokenFilteredCount').textContent=`显示 ${items.length} / ${summary.total} 枚`;
  if(!items.length){
    const empty=node('div','empty');empty.append(node('strong',null,tokens.length?'没有匹配的令牌':'还没有访问令牌'),node('p',null,tokens.length?'调整搜索或筛选条件后再试。':'拉取共享技能不需要令牌。需要修改时，点击右上方“新建令牌”。'));root.append(empty);
  }
  for(const t of items){
    const status=tokenStatus(t),row=node('article','row-card token-row'),info=node('div','token-identity');row.dataset.tokenId=t.id;row.setAttribute('aria-label',t.label+'，'+STATUS_LABELS[status]);
    const title=node('div','token-name-line');title.append(node('b',null,t.label),node('span','status-badge '+status,STATUS_LABELS[status]));
    info.append(title,node('small',null,'创建于 '+displayDate(t.created_at,{empty:'未知',dateOnly:true})));
    if(!t.recoverable)info.append(node('small',null,'旧令牌无可恢复副本，仍可按原权限使用。'));
    const role=node('div','token-cell token-role');role.dataset.label='访问权限';role.append(node('span','permission-badge '+(['shared_writer','all_writer'].includes(t.role)?t.role:'legacy'),TOKEN_ROLES[t.role]||'旧令牌'));
    if(t.permission_mode==='legacy')role.append(node('small',null,'旧项目范围 '+t.project_scope));
    const expires=node('div','token-cell',tokenLifetime(t));expires.dataset.label='有效期';
    const last=node('div','token-cell',displayDate(t.last_used_at));last.dataset.label='最近使用';
    const actions=node('div','token-actions');
    if(t.recoverable){const reveal=node('button','token-view-button','查看 / 复制');reveal.type='button';reveal.onclick=()=>showTokenValue(t);actions.append(reveal);}
    if(!t.revoked_at){
      const revoke=node('button',null,'撤销');revoke.type='button';
      revoke.onclick=async()=>{
        if(!confirm(`撤销“${t.label}”？使用此令牌的客户端将无法继续访问。`))return;
        const identity=state.me;clearVisibleTokens();revoke.disabled=true;
        try{await sensitiveApi(`/api/tokens/${t.id}/revoke`,'POST',{});if(identity!==state.me)return;await refreshTokens();toast('令牌已撤销');}
        catch(error){if(identity===state.me)toast(error.message,true);}
        finally{revoke.disabled=false;}
      };actions.append(revoke);
    }
    row.append(info,role,expires,last,actions);root.append(row);
  }
  $('revokeAllTokens').disabled=!tokens.some(t=>!t.revoked_at);
}
async function refreshTokens(){
  if(!state.me||state.mustChangePassword||loggingOut)return;
  clearRevealedToken();const generation=++tokenListGeneration,identity=tokenUiGeneration;
  $('tokensList').setAttribute('aria-busy','true');$('refreshTokens').disabled=true;$('tokenListError').hidden=true;
  try{
    const result=await api('/api/tokens');
    if(generation!==tokenListGeneration||identity!==tokenUiGeneration||!state.me||state.mustChangePassword||loggingOut)return;
    state.tokenStorageReady=result.tokenStorage?.configured===true;
    $('tokenStorageWarning').hidden=state.tokenStorageReady;
    $('tokenForm').querySelector('button[type="submit"]').disabled=!state.tokenStorageReady||tokenIssuing;
    state.tokens=result.tokens;renderTokenList();
  }catch(error){
    if(generation===tokenListGeneration&&state.me){
      state.tokens=[];state.tokenStorageReady=false;renderTokenList();
      $('tokenSummary').textContent='令牌列表加载失败';$('tokensList').replaceChildren();
      $('tokenListError').textContent=error.message+'，请点击“刷新”重试。';$('tokenListError').hidden=false;
      $('tokenForm').querySelector('button[type="submit"]').disabled=true;
    }
  }finally{if(generation===tokenListGeneration){$('tokensList').setAttribute('aria-busy','false');$('refreshTokens').disabled=false;}}
}
$('refreshTokens').onclick=refreshTokens;
for(const [id,event] of [['tokenSearch','input'],['tokenRoleFilter','change'],['tokenStatusFilter','change']])$(id).addEventListener(event,()=>{clearRevealedToken();renderTokenList();});
async function issue(ev){
  ev.preventDefault();if(tokenIssuing)return;
  const button=ev.target.querySelector('button[type="submit"]');tokenIssuing=true;button.disabled=true;button.textContent='正在生成…';
  const generation=tokenUiGeneration,identity=state.me;
  $('tokenCreateError').hidden=true;
  try{
    const role=$('tokenRole').value;
    const result=await sensitiveApi('/api/tokens','POST',{label:$('tokenLabel').value,role,expiresInDays:$('tokenDays').value==='never'?null:Number($('tokenDays').value)});
    if(identity!==state.me)return;
    await refreshTokens();
    if(generation!==tokenUiGeneration||!state.me||state.view!=='security'||document.hidden||!$('tokenCreateDialog').open)return;
    $('tokenSearch').value='';$('tokenRoleFilter').value='';$('tokenStatusFilter').value='';renderTokenList();
    clearIssuedToken();$('issuedValue').textContent=result.token;$('issuedToken').hidden=false;
    issuedTimer=setTimeout(clearIssuedToken,60000);toast('令牌已生成，以后也可从列表查看和复制');
  }catch(error){if(generation===tokenUiGeneration&&state.me){$('tokenCreateError').textContent=error.message;$('tokenCreateError').hidden=false;}}
  finally{tokenIssuing=false;button.disabled=!state.tokenStorageReady;button.textContent='生成令牌';}
}
async function newProject(ev){
  ev.preventDefault();const button=ev.target.querySelector('button[type="submit"]');if(button.disabled)return;
  const identity=state.me;button.disabled=true;
  try{await api('/api/projects','POST',{slug:$('newProjectSlug').value,title:$('newProjectTitle').value});if(identity!==state.me)return;$('projectForm').reset();toast('分类已创建');await refresh();}
  catch(error){if(identity===state.me)toast(error.message,true);}finally{button.disabled=false;}
}
document.querySelectorAll('.nav-item').forEach(el=>el.addEventListener('click',()=>view(el.dataset.view)));
document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>view(el.dataset.go)));
async function logout(){
  if(loggingOut||!state.me)return;
  if(activeUpload&&!confirm('上传正在进行，退出会中断当前上传。已发布的版本不会删除。确定退出？'))return;
  loggingOut=true;clearVisibleTokens();activeUpload?.abort();
  if($('reauthDialog').open)$('cancelReauth').click();
  document.querySelectorAll('[data-logout]').forEach(button=>button.disabled=true);$('logout').textContent='正在退出…';
  try{
    await api('/api/auth/logout','POST',{});
    clearLogin();$('usernameInput').focus();toast('已退出当前浏览器，客户端令牌不受影响');
    // A status refresh failure must not turn a confirmed logout into an apparent failure.
    try{await loadAuthStatus();}catch{}
  }catch(error){toast('退出未完成，请检查网络后重试。当前会话可能仍然有效。',true);}
  finally{loggingOut=false;document.querySelectorAll('[data-logout]').forEach(button=>button.disabled=false);$('logout').textContent='退出登录';}
}
document.querySelectorAll('[data-logout]').forEach(button=>button.addEventListener('click',logout));
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
  if(!confirm('撤销全部访问令牌？所有使用令牌的客户端之后都需要重新配置。已下载的文件不会被收回。'))return;
  try{clearVisibleTokens();await sensitiveApi('/api/auth/revoke-all-tokens','POST',{confirm:'revoke-all-api-tokens'});$('issuedToken').hidden=true;$('issuedValue').textContent='';await refreshTokens();toast('全部 API 令牌已撤销');}catch(error){toast(error.message,true);}
};
$('search').oninput=renderSkills;$('projectFilter').onchange=renderSkills;
$('skillFile').onchange=e=>onPicked(e,'file');$('skillFolder').onchange=e=>onPicked(e,'folder');$('skillZip').onchange=e=>onPicked(e,'zip');
$('publishForm').onsubmit=publish;$('tokenForm').onsubmit=issue;$('projectForm').onsubmit=newProject;
$('copyIssued').onclick=()=>{const value=$('issuedValue').textContent;if(value)navigator.clipboard.writeText(value).then(()=>toast('已复制到剪贴板')).catch(()=>toast('请手动复制令牌',true));};
authUi(false);
(async()=>{try{await loadAuthStatus();try{await acceptSession(await api('/api/auth/session'));}catch(error){if(error.status!==401)throw error;}}catch(error){$('authError').textContent=error.message;}})();
