/** API tokens only. Browser sessions and upload sessions keep independent time limits. */
import {problem} from '../public/lib/policy.js';
export const DEFAULT_TOKEN_DAYS=90;
export function validateTokenDays(days=DEFAULT_TOKEN_DAYS){
  // null is the explicit no-expiry choice; omission keeps the existing default.
  // Never coerce empty strings, zero, booleans or invalid values to permanent.
  if(days!==null&&(!Number.isInteger(days)||days<1||days>365))
    throw problem('Token lifetime must be null (never expires) or an integer from 1 to 365 days');
  return days;
}
export function parseTokenDaysOption(value){
  if(value==='never')return null;
  if(typeof value!=='string'||!/^[1-9][0-9]{0,2}$/.test(value))
    throw problem('--token-days must be never or an integer from 1 to 365');
  return validateTokenDays(Number(value));
}
