// Local-only integration fixture. No production Cloudflare account or persistent data is used.
import http from 'node:http';
import {Readable} from 'node:stream';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,api,setup} from './helpers.mjs';
import {handler} from '../src/index.js';
const f=fixture();
const root=new URL('../public/',import.meta.url);
f.env.ASSETS={async fetch(request){
  let name=decodeURIComponent(new URL(request.url).pathname);if(name==='/')name='/index.html';
  if(name.split('/').includes('..'))return new Response('Not found',{status:404});
  try{const bytes=await readFile(new URL('.'+name,root));const ext=path.extname(name);const type={'.js':'text/javascript','.css':'text/css','.html':'text/html'}[ext]||'application/octet-stream';return new Response(bytes,{headers:{'Content-Type':type}});}catch{return new Response('Not found',{status:404});}
}};
const server=http.createServer(async(req,res)=>{
  try{
    const response=await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half'}),f.env);
    res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch(e){res.writeHead(500);res.end(String(e));}
});
server.listen(0,'127.0.0.1',async()=>{
  const url=`http://127.0.0.1:${server.address().port}`;
  if(process.env.BROWSER_AUTH_FILE)await writeFile(process.env.BROWSER_AUTH_FILE,JSON.stringify({url,username:'browser-admin',password:'Browser isolated test password 12345',bootstrapSecret:f.env.BOOTSTRAP_SECRET}),{mode:0o600});
  console.log('Browser test fixture:',url);
});
process.on('SIGTERM',()=>server.close(()=>{f.close();process.exit();}));
