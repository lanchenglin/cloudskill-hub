/** Recoverable API token copies. The encryption key is a long-lived Worker Secret,
 * separate from D1 and BOOTSTRAP_SECRET. This does not encrypt Skill contents.
 * AES-256-GCM, fresh 96-bit IV, 128-bit tag, authenticated token id + stored digest.
 */
import {tokenHash} from './core.js';
import {problem} from '../public/lib/policy.js';
const encoder=new TextEncoder();
const errors=new Set(['token_key_unavailable','token_decryption_failed']);
const vaultError=code=>Object.assign(problem(code,503),{tokenVaultCode:code});
export const tokenVaultErrorCode=error=>errors.has(error?.tokenVaultCode)?error.tokenVaultCode:null;
export const tokenKeyConfigured=env=>typeof env.TOKEN_ENCRYPTION_KEY==='string'&&/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY);
async function key(env){
  if(!tokenKeyConfigured(env))throw vaultError('token_key_unavailable');
  return crypto.subtle.importKey('raw',Buffer.from(env.TOKEN_ENCRYPTION_KEY,'hex'),'AES-GCM',false,['encrypt','decrypt']);
}
function aad(id,digest){
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))
    throw vaultError('token_decryption_failed');
  return encoder.encode('cloudskill-hub/api-token/v1\0'+id+'\0'+digest);
}
export async function sealToken(env,id,digest,token){
  const k=await key(env);
  if(typeof token!=='string'||!/^csh_[a-f0-9]{48}$/.test(token)||await tokenHash(token)!==digest)
    throw vaultError('token_decryption_failed');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,digest),tagLength:128},k,encoder.encode(token));
  return 'v1:'+Buffer.from(iv).toString('hex')+':'+Buffer.from(encrypted).toString('hex');
}
export async function openToken(env,id,digest,box){
  const k=await key(env);
  try{
    if(typeof box!=='string')throw Error('Invalid encrypted token');
    const m=/^v1:([a-f0-9]{24}):([a-f0-9]{136})$/.exec(box);
    if(!m)throw Error('Invalid encrypted token');
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(m[1],'hex'),additionalData:aad(id,digest),tagLength:128},k,Buffer.from(m[2],'hex'));
    const token=new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
    if(!/^csh_[a-f0-9]{48}$/.test(token)||await tokenHash(token)!==digest)throw Error('Invalid decrypted token');
    return token;
  }catch{
    // Do not log crypto exceptions, ciphertext, the key, or decrypted data.
    throw vaultError('token_decryption_failed');
  }
}
