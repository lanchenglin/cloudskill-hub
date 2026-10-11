/** Short per-token instructions. Returned strings contain credentials: active dialog only. */
import {guideOrigin,GUIDE_AGENTS,shellQuote} from './usage-guide.js';
export const TOKEN_USAGE_ROLES=Object.freeze({shared_writer:'读取、修改共享技能',all_writer:'读取、修改共享与私有技能'});
export function buildTokenUsage({origin,token,role,agent='hermes',shell='bash'}={}){
  const hub=guideOrigin(origin);
  if(typeof token!=='string'||!/^csh_[a-f0-9]{48}$/.test(token))throw Error('令牌格式不正确');
  if(!Object.hasOwn(TOKEN_USAGE_ROLES,role))throw Error('旧类型令牌请按原权限使用；新用法支持修改共享或修改全部令牌');
  if(!Object.hasOwn(GUIDE_AGENTS,agent)||!['bash','powershell'].includes(shell))throw Error('请选择支持的工具和终端');
  const q=value=>shellQuote(value,shell);
  const prompt=[
    `请在当前 ${GUIDE_AGENTS[agent]} 所在环境连接我的 CloudSkill Hub：`,
    `地址：${hub}`,`Token：${token}`,`客户端用法：${hub}/usage.md`,
    '优先复用 cloudskill；缺少时按上述说明准备客户端，不部署服务端。',
    `先列出可用技能，等我选定后仅安装到当前工具（--agents ${agent}）；以后按我的要求手动更新。`,
    `此令牌可${TOKEN_USAGE_ROLES[role]}；本次只读取，不上传或公开技能，不覆盖本地修改。`,
    '沿用当前实例目录；令牌仅发送到上述 Hub，不回显、不写日志或提交 Git。',
    ...(agent==='codex'?['先核对当前 Codex 的实际技能加载目录，不能仅凭文件复制成功报告已加载。']:[]),
  ].join('\n');
  // Subshell/local scope restores any inherited credential even when a command fails.
  const commands=shell==='bash'?[
    '(',`  export CLOUDSKILL_TOKEN=${q(token)}`,
    `  cloudskill login ${q(hub)} && cloudskill list`,')',
  ].join('\n'):[
    '& {','  $previousToken = $env:CLOUDSKILL_TOKEN','  try {',
    `    $env:CLOUDSKILL_TOKEN = ${q(token)}`,`    cloudskill login ${q(hub)}`,
    "    if ($LASTEXITCODE -ne 0) { throw '登录失败，已停止' }",
    '    cloudskill list',"    if ($LASTEXITCODE -ne 0) { throw '读取失败，已停止' }",
    '  } finally { $env:CLOUDSKILL_TOKEN = $previousToken }','}',
  ].join('\n');
  return {prompt,commands};
}
export function sharedQuickPrompt(origin,agent='hermes'){
  const hub=guideOrigin(origin);
  if(!Object.hasOwn(GUIDE_AGENTS,agent))throw Error('请选择支持的工具');
  return `请阅读 ${hub}/usage.md，在当前 ${GUIDE_AGENTS[agent]} 环境连接 ${hub}，仅查看共享技能，无需 Token。先列出技能让我选择，再按 --agents ${agent} 安装；不部署服务端，不覆盖本地修改。`;
}
