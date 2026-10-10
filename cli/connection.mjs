/** Anonymous connections are explicit; a bad token never falls back to public access. */
export function connectionHeaders(config){
  if(config.token===null)return {};
  if(typeof config.token!=='string'||!/^csh_[a-f0-9]{48}$/.test(config.token))throw Error('Invalid CloudSkill API token');
  return {Authorization:'Bearer '+config.token};
}
export function connectionPath(config,endpoint,method='GET'){
  if(config.token!==null)return endpoint;
  if(method!=='GET')throw Error('Shared read-only connection: a write token from the website is required to publish');
  if(!['/api/me','/api/projects','/api/catalog','/api/skills','/api/capabilities'].includes(endpoint.split('?')[0])&&
     !/^\/api\/projects\/[a-z0-9-]+\/skills\/[a-z0-9-]+\/(download|versions(?:\/[0-9]+(?:\/(download|file))?)?)(?:\?.*)?$/.test(endpoint))
    throw Error('This operation is not available on a shared read-only connection');
  return '/api/public/'+endpoint.slice('/api/'.length);
}
