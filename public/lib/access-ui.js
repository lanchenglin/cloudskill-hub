/** Presentation only: never accept, retain or search token secrets here. */
export const TOKEN_ROLES=Object.freeze({shared_writer:'修改共享技能',all_writer:'修改全部技能',client:'旧只读令牌',publisher:'旧项目发布令牌',admin:'旧管理员 API'});
export function tokenStatus(token,time=Date.now()){
  if(token.revoked_at)return 'revoked';
  if(token.expires_at===null)return 'active';
  const expiry=typeof token.expires_at==='string'?Date.parse(token.expires_at):NaN;
  return Number.isFinite(expiry)?(expiry<=time?'expired':'active'):'unknown';
}
export const STATUS_LABELS=Object.freeze({active:'有效',expired:'已过期',revoked:'已撤销',unknown:'待核实'});
export function tokenSummary(tokens,time=Date.now()){
  const result={total:tokens.length,active:0,expired:0,revoked:0,unknown:0};
  for(const token of tokens)result[tokenStatus(token,time)]++;
  return result;
}
export function filterTokens(tokens,{query='',role='',status=''}={},time=Date.now()){
  const text=String(query).trim().toLocaleLowerCase();
  return tokens.filter(token=>(!text||String(token.label||'').toLocaleLowerCase().includes(text))&&
    (!role||token.role===role)&&(!status||tokenStatus(token,time)===status));
}
export function displayDate(value,{empty='从未使用',dateOnly=false}={}){
  if(!value)return empty;
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '时间未知';
  const options={year:'numeric',month:'2-digit',day:'2-digit',...(dateOnly?{}:{hour:'2-digit',minute:'2-digit',hour12:false})};
  return new Intl.DateTimeFormat('zh-CN',options).format(date);
}
export function tokenLifetime(token){
  return token.expires_at===null?'永久有效':displayDate(token.expires_at,{empty:'期限未知',dateOnly:true});
}
