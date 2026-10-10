/** Content permissions are independent from website administration. */
import {problem} from '../public/lib/policy.js';
export const GUEST=Object.freeze({id:null,label:'Shared visitor',role:'guest',projects:[],authType:'anonymous',expiresAt:null});
export const sharedOnly=u=>u.role==='guest'||u.role==='shared_writer';
// Project access is not sufficient to read a skill: callers MUST also check its visibility.
export const allowed=(u,p)=>['admin','all_writer','shared_writer','guest'].includes(u.role)||u.projects.includes(p);
export const canReadSkill=(u,p,visibility)=>sharedOnly(u)?visibility==='public':allowed(u,p);
export function admin(u){if(u.role!=='admin')throw problem('Administrator access required',403);}
export function access(u,p){if(!allowed(u,p))throw problem('Project access denied',403);}
export function readSkill(u,p,visibility,publishedVisibility){
  access(u,p);
  if(!canReadSkill(u,p,visibility)||(sharedOnly(u)&&publishedVisibility!==undefined&&publishedVisibility!=='public'))
    throw problem('Skill or version not found',404);
}
export function publisher(u,p){
  if(!['admin','publisher','shared_writer','all_writer'].includes(u.role))throw problem('Publishing permission required',403);
  if(p!==undefined)access(u,p);
}
export function publishVisibility(u,p,visibility,currentVisibility){
  publisher(u,p);
  if(u.role==='shared_writer'){
    if(currentVisibility==='private')throw problem('Skill not found',404);
    if(visibility!=='public')throw problem('This token can only modify shared skills',403);
  }
  // Old project-scoped credentials retain their original access; never elevate them during migration.
  if(u.role==='publisher'&&(visibility==='public'||currentVisibility==='public'))
    throw problem('Legacy publisher tokens can only publish private skills',403);
}
export const defaultVisibility=(u,current)=>current??(u.role==='shared_writer'?'public':'private');
export function tokenRole(row){
  if(row.permission_mode==='shared')return 'shared_writer';
  if(row.permission_mode==='all')return 'all_writer';
  return row.role==='admin'?'admin':row.can_publish?'publisher':'client';
}
