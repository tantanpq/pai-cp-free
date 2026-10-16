'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const{spawnSync}=require('node:child_process');
const ROOT='C:\\Program Files\\PAI\\AdminBridgeR2';
const canonical=o=>o===null||typeof o!=='object'?JSON.stringify(o):Array.isArray(o)?'['+o.map(canonical).join(',')+']':'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
function plain(root,relative){let p=path.resolve(root);const target=path.join(root,relative);for(const part of [p,...relative.split(path.sep)]){if(part!==p)p=path.join(p,part);const s=fs.lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&p!==target)||p===target&&s.isFile()&&s.nlink!==1)throw Error('ADMIN_PATH_DENIED');}return target;}
function createAdminBridgeClient({root=ROOT,startTask,waitMs=20000}={}){
 const read=(relative,max=16384)=>{const file=plain(root,relative);if(fs.statSync(file).size>max)throw Error('ADMIN_SIZE_DENIED');return JSON.parse(fs.readFileSync(file,'utf8'));};
 const result=nonce=>{if(!id(nonce))throw Error('ADMIN_NONCE_INVALID');try{return{status:'COMPLETED',receipt:read(path.join('results',nonce+'.json'))};}catch(e){if(e.code==='ENOENT')return{status:'WAITING',nonce};throw e;}};
 const start=startTask||(()=>{const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',"Start-ScheduledTask -TaskName 'PAI Admin Bridge R2' -TaskPath '\\PAI\\'"],{windowsHide:true,timeout:10000,encoding:'utf8'});if(r.error||r.status!==0)throw Error('ADMIN_TASK_START_FAILED');});
 return{async run(payload){
  if(process.env.PAI_GATEWAY_CANARY==='1')throw Error('ADMIN_DISABLED_IN_CANARY');
  const op=payload.operation;
  if(op==='ADMIN_STATUS'){const active=read('active.json'),policy=read('policy.json');return{status:'READY',scope:'SIGNED_FIXED_TARGETS',targets:policy.targets||['ADMIN_BRIDGE_SELF'],active,approvalRequired:true,signer:'ELEVATED_FOUNDER_ONLY',publicKeyFingerprint:crypto.createHash('sha256').update(crypto.createPublicKey(policy.approvedKeys.FOUNDER_TOM).export({type:'spki',format:'der'})).digest('hex')};}
  if(op==='ADMIN_RESULT')return result(payload.nonce);
  if(op!=='ADMIN_SUBMIT'||!payload.envelope)throw Error('ADMIN_OPERATION_INVALID');
  const envelope=payload.envelope,p=envelope.permit,policy=read('policy.json');
  if(!p||!id(p.nonce)||!id(p.issuer)||!['ADMIN_BRIDGE_SELF','CHIEF_RUNTIME'].includes(p.target)||p.scope!=='HOME_ADMIN_BRIDGE_R2'||!['HEALTH_CHECK','RELEASE_VERIFY_ONLY','INSTALL_RELEASE','ROLLBACK'].includes(p.action))throw Error('ADMIN_PERMIT_SCOPE_DENIED');
  if(p.target==='CHIEF_RUNTIME'&&!policy.targets?.includes(p.target))throw Error('ADMIN_PERMIT_SCOPE_DENIED');
  const key=policy.approvedKeys[p.issuer];if(!key||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))throw Error('ADMIN_SIGNATURE_DENIED');
  const signature=Buffer.from(envelope.signature,'base64');if(signature.toString('base64')!==envelope.signature||!crypto.verify(null,Buffer.from(canonical(p)),key,signature))throw Error('ADMIN_SIGNATURE_DENIED');
  const existing=result(p.nonce);if(existing.status==='COMPLETED')return{...existing,idempotent:true};
  const now=Math.floor(Date.now()/1000);if(!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now||p.expiresAt<=now||p.expiresAt-p.issuedAt>120)throw Error('ADMIN_PERMIT_EXPIRED');
  const bytes=Buffer.from(canonical(envelope));if(bytes.length>16384)throw Error('ADMIN_SIZE_DENIED');
  const lockRoot=path.join(process.env.LOCALAPPDATA||require('node:os').tmpdir(),'PAI','AdminBridgeR2');fs.mkdirSync(lockRoot,{recursive:true});const lock=path.join(lockRoot,'client.lock');let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce:p.nonce}));fs.fsyncSync(fd);
   fs.writeFileSync(plain(root,path.join('intake','request.json')),bytes);start();const deadline=Date.now()+waitMs;
   do{const r=result(p.nonce);if(r.status==='COMPLETED')return r;await new Promise(resolve=>setTimeout(resolve,250));}while(Date.now()<deadline);
   return{status:'WAITING',nonce:p.nonce,reason:'READ_RECEIPT_REQUIRED'};
  }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
 }};
}
module.exports={createAdminBridgeClient,canonical};
