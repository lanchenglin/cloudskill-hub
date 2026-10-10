/** Native memory-hard password hashing. Never reuse the fast API-token hash for passwords.
 * OWASP scrypt profile: N=2^14, r=8, p=5 (~16 MiB working memory).
 * https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
 */
import {scrypt, randomBytes, timingSafeEqual} from 'node:crypto';
import {problem} from '../public/lib/policy.js';
import {INITIAL_ADMIN_PASSWORD,validatePassword,validateNewPassword} from '../public/lib/password-policy.js';
export {INITIAL_ADMIN_PASSWORD,validatePassword} from '../public/lib/password-policy.js';
export const PASSWORD_PROFILE = Object.freeze({N:16384,r:8,p:5,maxmem:32*1024*1024});
export function validateUsername(value){
  if(typeof value!=='string')throw problem('Username must be 3–64 ASCII letters, numbers, dot, underscore or hyphen');
  const name=value.trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(name))throw problem('Username must be 3–64 ASCII letters, numbers, dot, underscore or hyphen');
  return name;
}
let active=0;
async function derive(password,salt){
  // Bound memory consumed by concurrent authentication in a single isolate.
  if(active>=2)throw problem('Authentication is busy. Try again shortly.',503);
  active++;
  try{return await new Promise((resolve,reject)=>scrypt(password,salt,32,PASSWORD_PROFILE,(error,key)=>error?reject(error):resolve(key)));}
  finally{active--;}
}
async function encodePassword(password){
  const salt=randomBytes(16).toString('hex');
  const key=await derive(password,Buffer.from(salt,'hex'));
  return `scrypt$16384$8$5$${salt}$${key.toString('hex')}`;
}
export async function hashPassword(password){
  validateNewPassword(password);return encodePassword(password);
}
/** Initial setup allows the public default; every supplied value still obeys 6–20. */
export async function hashInitialPassword(password=INITIAL_ADMIN_PASSWORD){
  validatePassword(password);
  return encodePassword(password);
}
export async function verifyPassword(password,stored){
  // Old stored credentials may be longer than 20. Keep them usable until explicitly changed.
  if(typeof password!=='string'||[...password].length>128)return false;
  const match=/^scrypt\$16384\$8\$5\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored||'');
  if(!match)throw problem('Unsupported password hash; use trusted account recovery',503);
  const key=await derive(password,Buffer.from(match[1],'hex'));
  return timingSafeEqual(key,Buffer.from(match[2],'hex'));
}
