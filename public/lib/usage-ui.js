import {sharedQuickPrompt} from './token-usage.js';
/** Reusable guide in the admin view and the anonymous standalone page. */
import {buildUsageGuide,guideOrigin,GUIDE_AGENTS,GUIDE_TASKS} from './usage-guide.js';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
export function mountUsageGuide(root,{origin,onTokens}={}){
  const hub=guideOrigin(origin);let model=null,copyEpoch=0;
  // Fixed trusted markup only. Catalog/user strings are inserted with textContent/value below.
  root.innerHTML=`
    <div class="guide-intro"><div><h1>怎么使用技能<span class="mark">.</span></h1><p>有 Token：在“访问权限”点开令牌，直接复制它的用法。</p></div><button type="button" class="primary" data-guide="token-entry">打开访问权限 →</button></div>
    <div class="panel guide-quick"><div class="panel-heading"><div><h2>只下载共享技能？</h2><p>不需要 Token，复制这段话给 AI 即可。</p></div><select data-guide="quick-agent" aria-label="共享技能的目标工具"><option value="hermes">Hermes</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select></div><textarea data-guide="quick-prompt" readonly aria-label="共享技能简短用法"></textarea><button type="button" class="primary" data-guide="copy-quick">复制给 AI</button><p data-guide="quick-status" role="status" class="guide-copy-status"></p></div>
    <div class="guide-address"><span>当前 Hub</span><code data-guide="origin"></code><button type="button" class="text-button" data-guide="copy-link">复制说明地址</button></div>
    <details class="guide-advanced" data-guide="advanced"><summary>指定技能 / 完整命令（可选）</summary>
    <div class="guide-layout">
      <form class="panel compact-form guide-options" data-guide="form" autocomplete="off">
        <h2>我要做什么</h2>
        <div class="field"><label for="guideAgent">AI 工具</label><select id="guideAgent" data-guide="agent"></select></div>
        <div class="field"><label for="guideTask">操作</label><select id="guideTask" data-guide="task"></select></div>
        <div class="field"><label for="guideAccess">技能访问方式</label><select id="guideAccess" data-guide="access"><option value="public">共享技能 · 无令牌下载</option><option value="private">私有技能 · 使用修改全部 Token</option></select><p class="field-hint" data-guide="access-note"></p></div>
        <div class="field"><label for="guideShell">终端环境</label><select id="guideShell" data-guide="shell"><option value="bash">Linux / WSL / macOS（Bash）</option><option value="powershell">Windows（PowerShell）</option></select></div>
        <div class="field" data-guide="existing-field"><label for="guideExisting">选择已有技能（可选）</label><select id="guideExisting" data-guide="existing"><option value="">手动填写 / 先让 AI 列出技能</option></select></div>
        <div class="field" data-guide="project-field"><label for="guideProject">分类英文 ID</label><input id="guideProject" data-guide="project" list="guideProjects" maxlength="64" placeholder="例如 personal" spellcheck="false" /><datalist id="guideProjects"></datalist><p class="field-hint">在“项目分类”中查看英文 ID，不是中文展示名。</p></div>
        <div class="field" data-guide="skill-field"><label for="guideSkill">技能英文 ID</label><input id="guideSkill" data-guide="skill" list="guideSkills" maxlength="64" placeholder="例如 linux-audit" spellcheck="false" /><datalist id="guideSkills"></datalist><p class="field-hint">不确定名称可以留空，让 AI 先列出技能供你选择。</p></div>
        <div class="field" data-guide="source-field" hidden><label for="guideSource">本地技能目录或 ZIP</label><input id="guideSource" data-guide="source" maxlength="1024" placeholder="例如 ./my-skill" spellcheck="false" /><p class="field-hint">这是 AI 所在机器的路径，不是网页上传文件。</p></div>
        <p class="guide-catalog-note" data-guide="catalog-note"></p>
      </form>
      <div class="guide-result">
        <div class="panel guide-prompt-panel"><div class="panel-heading"><div><span class="guide-kicker">COPY & ASK</span><h2>直接复制给 AI</h2><p>已带入本站地址；不会带入你的密码或 Token。</p></div><button type="button" class="primary" data-guide="copy-prompt">复制给 AI</button></div>
          <p class="notice notice-warning" data-guide="error" role="alert" hidden></p>
          <p class="guide-target-note" data-guide="target-note"></p>
          <label class="sr-only" for="guidePrompt">给 AI 的完整操作说明</label><textarea id="guidePrompt" data-guide="prompt" readonly spellcheck="false"></textarea>
          <p class="guide-copy-status" data-guide="copy-status" role="status" aria-live="polite"></p>
        </div>
        <details class="panel guide-command-panel" open><summary>对应命令 <span>熟悉终端时也可手动执行</span></summary><p class="field-hint">先核对连接、目录和范围。任一步报错就停止，不要连续执行后续写入。</p><pre data-guide="commands"></pre><button type="button" class="secondary" data-guide="copy-commands">复制命令</button></details>
        <div class="notice guide-scope-note" data-guide="notice"></div>
      </div>
    </div>
    <div class="guide-reference-grid">
      <details class="panel"><summary>第一次使用：客户端怎么安装？</summary><p>只需给 AI 所在机器准备客户端，不是重新部署 Hub。优先使用已有客户端，Node.js 至少 22.16。</p><pre data-guide="setup"></pre><p>不方便注册全局命令时，留在源码目录，用 <code>node cli/cloudskill.mjs</code> 替代 <code>cloudskill</code>。不要把示例目录覆盖到已有项目，不需要 Cloudflare 账号密钥。</p></details>
      <details class="panel"><summary>私有技能的 Token 应该怎么给？</summary><p>网页“访问权限 → 新建令牌”，私有技能选择“修改全部技能”；可以设置永久。已有令牌可在列表再次查看。</p><p>在 AI 所在机器的交互终端运行 <code>cloudskill login</code> 并带上本站地址，按隐藏提示粘贴 Token。自动执行环境需预先安全注入 <code>CLOUDSKILL_TOKEN</code>。令牌弹窗可明确复制含 Token 的简短用法，仅交给可信 AI；不是把网页登录密码给 AI。</p><p>同一 Token 可用于多套可信环境；单独签发方便撤销，但不按设备绑定。缺少 Token 时 AI 应停止并提示配置，不能绕过私有权限。</p></details>
      <details class="panel"><summary>install / update / subscribe / sync 有什么区别？</summary><p><b>install</b> 下载一个技能并建立本地管理记录；<b>update</b> 更新当前配置内全部已安装技能，不会自动安装新技能。</p><p><b>subscribe</b> 设置分类订阅；<b>sync</b> 对当前配置全部订阅安装新增和更新已有技能。同分类重新订阅会替换旧设置。它们是手动操作，不会自动互相推送。</p><p>某套 Hermes 修改后执行 <b>publish</b>，其他环境需要时执行 <b>update / sync</b>。不要混用另一套管理器更新同一个目录。</p></details>
      <details class="panel"><summary>只下载 ZIP、或者使用其他 AI 工具？</summary><p>打开技能详情，点击“下载此版本 ZIP”。共享内容也可以从<a href="/shared.html">共享技能页</a>直接下载；私有内容需要合法登录。</p><p>下载 ZIP 只是拿到文件，不等于已安装，也不会加入 CloudSkill 更新记录。导入其他工具时要核对它的实际技能目录，保留 <code>SKILL.md</code> 和附属资源。当前 CLI 只接受 hermes、claude、codex，不能随便填写未来工具名。</p></details>
      <details class="panel"><summary>同一台机器有多套 Hermes 怎么区分？</summary><p>每套环境同时使用它自己的 <code>HERMES_HOME</code> 和 <code>CLOUDSKILL_CONFIG_DIR</code>；安装、发布、更新时保持一致。Windows 与 WSL 也是不同环境。</p><pre>Linux / WSL：
export HERMES_HOME="$HOME/hermes-dev"
export CLOUDSKILL_CONFIG_DIR="$HOME/.config/cloudskill-hermes-dev"

PowerShell：
$env:HERMES_HOME = "$HOME/hermes-dev"
$env:CLOUDSKILL_CONFIG_DIR = "$HOME/.config/cloudskill-hermes-dev"</pre><p>上面仅为示例；先让 AI 查明现有实例的实际路径，不要直接创建或更改另一套实例。</p></details>
      <details class="panel"><summary>下载了但 AI 没发现，或者命令报错？</summary><p>先确认完整 ID、权限、AI 实际运行环境和安装目录。文件复制成功不等于 AI 已加载；同名技能可能来自另一个目录。必要时按工具自身说明刷新或重开会话。</p><p>401：令牌错误、到期或撤销。403：权限不足或初次改密未完成。提示本地修改 / 未托管同名目录：先停止比较，不直接 <code>--force</code>、删除目录或改本地记录。</p><p>Codex 当前目录适配器仍是 <code>CODEX_HOME/skills</code>，需核对你的 Codex 版本；目录不一致时应先确认适配，不假报成功。</p></details>
    </div>
    </details>
    <p class="guide-footer">仅复制说明不会执行任何安装或部署。AI 需要具备目标机器的终端、文件和网络权限；共享内容不能包含私人凭据。</p>`;
  const get=name=>root.querySelector(`[data-guide="${name}"]`);
  for(const [value,label] of Object.entries(GUIDE_AGENTS)){const option=el('option',label);option.value=value;get('agent').append(option);}
  for(const [value,label] of Object.entries(GUIDE_TASKS)){const option=el('option',label);option.value=value;get('task').append(option);}
  get('origin').textContent=hub;
  get('token-entry').onclick=()=>onTokens?onTokens():location.assign('/');
  function updateQuick(){get('quick-prompt').value=sharedQuickPrompt(hub,get('quick-agent').value);get('quick-status').textContent='';}
  get('quick-agent').onchange=updateQuick;updateQuick();
  get('copy-quick').onclick=async()=>{const value=get('quick-prompt').value;try{await navigator.clipboard.writeText(value);get('quick-status').textContent='已复制，发给对应 AI 即可。';}catch{get('quick-prompt').focus();get('quick-prompt').select();get('quick-status').textContent='请手动复制已选中的文本。';}};

  const values=()=>Object.fromEntries(['agent','task','access','shell','project','skill','source'].map(key=>[key,get(key).value]));
  function update(){
    copyEpoch++;get('copy-status').textContent='';const input=values();
    get('existing-field').hidden=input.task!=='install';get('project-field').hidden=input.task==='update';get('skill-field').hidden=input.task!=='install';get('source-field').hidden=input.task!=='publish';get('agent').disabled=input.task==='update'||input.task==='publish';
    // Hidden inputs must never contaminate another operation or leak its local path.
    if(input.task==='update'){input.project='';input.skill='';}if(input.task!=='publish')input.source='';if(input.task!=='install')input.skill='';
    try{
      model=buildUsageGuide({origin:hub,...input});get('error').hidden=true;get('error').textContent='';
      get('prompt').value=model.prompt;get('commands').textContent=model.commands;get('setup').textContent=model.setup;get('notice').textContent=model.notice;get('access-note').textContent=model.requirement;
      get('target-note').textContent=model.incomplete?'信息尚未填全：这段话会让 AI 先列出选项或询问，不会让它盲目安装。':'可以复制：先预检查，只在权限、范围和目录都正确时执行。';
      get('copy-prompt').disabled=false;get('copy-commands').disabled=false;
    }catch(error){model=null;get('prompt').value='';get('commands').textContent='';get('error').textContent=error.message;get('error').hidden=false;get('copy-prompt').disabled=true;get('copy-commands').disabled=true;get('target-note').textContent='请先修正输入，旧命令已清空。';}
  }
  get('form').addEventListener('submit',event=>event.preventDefault());get('form').addEventListener('input',update);get('form').addEventListener('change',update);
  async function copy(value){
    if(!value)return;const epoch=copyEpoch;
    try{await navigator.clipboard.writeText(value);if(epoch===copyEpoch){get('copy-status').textContent='已复制。把内容发给对应机器上的 AI 即可。';get('quick-status').textContent='已复制。';}}
    catch{if(epoch!==copyEpoch)return;get('advanced').open=true;get('copy-status').textContent='浏览器不允许自动复制，请手动选中复制下方文本。';get('prompt').value=value;get('prompt').focus();get('prompt').select();}
  }
  get('copy-prompt').onclick=()=>copy(model?.prompt);get('copy-commands').onclick=()=>copy(model?.commands);get('copy-link').onclick=()=>copy(hub+'/usage.md');
  function setSkills(skills){
    const projects=root.querySelector('#guideProjects'),names=root.querySelector('#guideSkills'),existing=get('existing'),selected=existing.value;projects.replaceChildren();names.replaceChildren();existing.replaceChildren();const empty=el('option','手动填写 / 先让 AI 列出技能');empty.value='';existing.append(empty);
    const seen=new Set();let count=0;
    for(const item of Array.isArray(skills)?skills:[]){
      if(!item||!['project','slug'].every(k=>typeof item[k]==='string'&&item[k].length<=64&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item[k])))continue;
      if(!seen.has(item.project)){const option=el('option');option.value=item.project;projects.append(option);seen.add(item.project);}
      const choice=el('option',item.project+'/'+item.slug+' · '+(item.visibility==='private'?'私有':'共享'));choice.value=item.project+'/'+item.slug;choice.dataset.visibility=item.visibility==='private'?'private':'public';existing.append(choice);
      const option=el('option',item.project+' / '+(item.visibility==='private'?'私有':'共享'));option.value=item.slug;names.append(option);count++;
    }
    if([...existing.options].some(option=>option.value===selected))existing.value=selected;
    get('catalog-note').textContent=count?`可参考 ${count} 个可见技能的英文 ID；也可从技能详情点击“让 AI 安装”。`:'暂无技能候选，仍可填写英文 ID，或先让 AI 列出可用技能。';
  }
  function selectSkill(skill){
    get('advanced').open=true;
    const full=(skill.project??'')+'/'+(skill.slug??'');get('existing').value=[...get('existing').options].some(option=>option.value===full)?full:'';
    get('task').value='install';get('project').value=skill.project??'';get('skill').value=skill.slug??'';get('access').value=skill.visibility==='private'?'private':'public';get('source').value='';update();
  }
  get('existing').addEventListener('change',()=>{const value=get('existing').value;if(!value)return;const [project,slug]=value.split('/');selectSkill({project,slug,visibility:get('existing').selectedOptions[0].dataset.visibility});});
  function clear(){get('advanced').open=false;get('quick-agent').value='hermes';updateQuick();get('form').reset();setSkills([]);update();}
  setSkills([]);update();return {setSkills,selectSkill,clear};
}
