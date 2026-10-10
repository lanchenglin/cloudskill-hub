/** Shared browser/server policy. Length is Unicode code points, never UTF-8 bytes. */
import {problem} from './policy.js';
export const MIN_PASSWORD_LENGTH=6, MAX_PASSWORD_LENGTH=20;
export const INITIAL_ADMIN_PASSWORD='lanchenglin'; // Public initial login value only.
export function validatePassword(value){
  if(typeof value!=='string'||[...value].length<MIN_PASSWORD_LENGTH||[...value].length>MAX_PASSWORD_LENGTH)
    throw problem('Password must contain 6–20 characters; spaces and Unicode are allowed');
  // Preserve case, whitespace and Unicode exactly; no trimming, normalization or truncation.
  return value;
}
export function validateNewPassword(value){
  validatePassword(value);
  if(value===INITIAL_ADMIN_PASSWORD)throw problem('Choose a password different from the public initial password');
  return value;
}
