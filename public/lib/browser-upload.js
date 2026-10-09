import {pack} from './archive.js';
import {frontmatter} from './metadata.js';
/** A session id is not a credential. Only the creating admin token can resume it. */
export async function publishBrowser({entries,limits,project,visibility,baseVersion,api,token,csrfToken,signal,progress=()=>{},pending=null,onPending=()=>{}}){
  const md=entries.find(e=>e.name==='SKILL.md');if(!md)throw Error('根目录必须包含 SKILL.md');
  const name=frontmatter(await md.blob.text()).name;
  const pkg=await pack(entries,limits,event=>{signal?.throwIfAborted();progress(event);});signal?.throwIfAborted();
  let session;
  if(pending&&pending.project===project&&pending.slug===name&&pending.digest===pkg.manifest.archiveDigest&&pending.visibility===visibility){
    try{session=await api(`/api/uploads/${pending.id}`);}catch(error){if(error.status!==404&&error.status!==410)throw error;}
    if(session&&session.state!=='cancelled'){
      if(session.project!==project||session.slug!==name||session.manifest?.archiveDigest!==pkg.manifest.archiveDigest)
        throw Error('服务器上传会话与当前文件不匹配，请放弃旧会话后重新发布');
      if(session.visibility!==visibility)
        throw Error('上传会话的可见性与当前选择不一致，请放弃旧会话后重新发布；不会自动公开私有技能');
    }
    if(session?.state==='committed'){onPending(null);return session.result;}
    if(session?.state==='cancelled')session=null;
  }
  if(!session){
    if(pending){try{await api(`/api/uploads/${pending.id}`,'DELETE');}catch{/* Expired/committed/other-owner sessions are never force deleted. */}}
    session=await api(`/api/projects/${project}/skills/${name}/uploads`,'POST',{...pkg.manifest,visibility,baseVersion});
    onPending({id:session.id,project,slug:name,digest:pkg.manifest.archiveDigest,visibility});
  }
  const id=session.id;progress({phase:'session',id});
  try{
    signal?.throwIfAborted();
    if(session.state==='created')await uploadZip(`/api/uploads/${id}/archive`,pkg.blob,token,csrfToken,signal,progress);
    else if(session.state!=='ready')throw Error('上传会话正在处理或不可用，请取消旧会话后重试');
    signal?.throwIfAborted();progress({phase:'finalize'});
    const result=await api(`/api/uploads/${id}/finalize`,'POST',{});onPending(null);return result;
  }catch(error){
    // Resolve ambiguous network failures without duplicating a version.
    let status;try{status=await api(`/api/uploads/${id}`);}catch{}
    if(status?.state==='committed'){onPending(null);return status.result;}
    if(signal?.aborted){try{await api(`/api/uploads/${id}`,'DELETE');onPending(null);}catch{}throw Error('上传已取消；尚未发布的临时文件将被清理。');}
    throw Error(`${error.message}。会话 ${id} 已保留；重新选择相同文件后点击发布可重试。`);
  }
}
function uploadZip(endpoint,blob,token,csrfToken,signal,progress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();const abort=()=>xhr.abort();
    const finish=(error,value)=>{signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    xhr.open('PUT',endpoint);xhr.timeout=300000;
    if(token)xhr.setRequestHeader('Authorization','Bearer '+token);
    else {xhr.setRequestHeader('X-CloudSkill-Request','1');xhr.setRequestHeader('X-CSRF-Token',csrfToken||'');}
    xhr.setRequestHeader('Content-Type','application/zip');
    xhr.upload.onprogress=e=>progress({phase:'upload',done:e.loaded,total:e.lengthComputable?e.total:blob.size});
    xhr.onload=()=>{let data;try{data=JSON.parse(xhr.responseText);}catch{return finish(Error('上传响应不是 JSON（HTTP '+xhr.status+'）'));}
      if(new URL(xhr.responseURL).origin!==location.origin)return finish(Error('拒绝跨站上传响应'));
      if(xhr.status<200||xhr.status>=300)return finish(Error(data.error||'上传失败'));finish(null,data);};
    xhr.onerror=()=>finish(Error('上传网络中断'));xhr.ontimeout=()=>finish(Error('上传超时（5 分钟），可重新上传'));xhr.onabort=()=>finish(Error('上传已取消'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return finish(Error('上传已取消'));xhr.send(blob);
  });
}
