import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
export function readBounded(file,limit) {
 const fd=fs.openSync(file,'r');
 try {
  if(fs.fstatSync(fd).size>limit)throw Error('SYS_EXEC_OUTPUT_LIMIT');
  let offset=0,chunks=[];
  for(;;) {
   const buffer=Buffer.alloc(Math.min(65536,limit-offset+1));
   const n=fs.readSync(fd,buffer,0,buffer.length,offset);
   if(!n)break;
   if(offset+n>limit)throw Error('SYS_EXEC_OUTPUT_LIMIT');
   chunks.push(buffer.subarray(0,n));offset+=n;
  }
  return Buffer.concat(chunks);
 } finally {fs.closeSync(fd);}
}
export async function runPSFile(command,timeoutMs,root) {
 const limit=64*1024*1024,t=Math.min(Math.max(1000,timeoutMs|0||30000),300000);
 const dir=path.join(root,crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
 const stdoutFile=path.join(dir,'stdout.log'),stderrFile=path.join(dir,'stderr.log'),handles=[];
 let child;
 try {
  handles.push(fs.openSync(stdoutFile,'wx'));handles.push(fs.openSync(stderrFile,'wx'));
  child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n"+command],{windowsHide:true,stdio:['ignore',...handles]});
 } finally {handles.forEach(fd=>fs.closeSync(fd));}
 return await new Promise((resolve,reject)=>{
  let settled=false,pendingError=null,hardTimer,killNote=' (tree termination not yet verified)';
  const finish=(error,code)=>{
   if(settled)return;settled=true;
   clearTimeout(deadline);clearInterval(budget);clearTimeout(hardTimer);
   if(error||pendingError)return reject(error||Error(pendingError.message+killNote));
   try {
    if(!Number.isInteger(code))throw Error('SYS_EXEC_EXIT_UNVERIFIED');
    const stdout=readBounded(stdoutFile,limit),stderr=readBounded(stderrFile,limit-stdout.length);
    resolve({exitCode:code,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')});
   } catch(e) {reject(e);}
  };
  const terminate=error=>{
   if(pendingError)return;pendingError=error;
   hardTimer=setTimeout(()=>finish(Error(error.message+' (termination unverified)')),15000);
   if(child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{timeout:10000,windowsHide:true},err=>{killNote=err?' (taskkill outcome unverified)':' (taskkill native exit 0)';});
   else child.kill();
  };
  const deadline=setTimeout(()=>terminate(Error('SYS_EXEC_TIMEOUT after '+t+'ms')),t);
  const budget=setInterval(()=>{
   try {if(fs.statSync(stdoutFile).size+fs.statSync(stderrFile).size>limit)terminate(Error('SYS_EXEC_OUTPUT_LIMIT'));}
   catch(e){terminate(e);}
  },100);
  child.once('error',e=>finish(Error('SYS_EXEC_SPAWN_FAILED: '+e.message)));
  child.once('close',code=>finish(null,code));
 });
}
