import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
/** Read a secret without terminal echo. Automation must use a protected file/environment instead. */
export async function promptSecret(label){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('A terminal is required; use a protected credential file for automation');
  const muted=new Writable({write(_chunk,_encoding,callback){callback();}});
  const controller=new AbortController();
  const rl=createInterface({input:process.stdin,output:muted,terminal:true});
  rl.on('SIGINT',()=>controller.abort());
  process.stdout.write(label);
  try{return await rl.question('',{signal:controller.signal});}
  finally{rl.close();process.stdout.write('\n');}
}
