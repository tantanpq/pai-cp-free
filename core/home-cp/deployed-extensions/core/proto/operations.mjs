import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

export const canonical = value => value === null || typeof value !== 'object'
  ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
export const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
export const effectActions = new Set(['chat.send','create.press','video.create','cp.step']);
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
async function atomic(file, value) {
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  const fd=await fs.open(temp,'wx');
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await fs.rename(temp,file);
}
export async function acquireBrowser(cdpUrl,{leaseApi,getTargets}={}) {
  const api=leaseApi||await import(pathToFileURL('C:/temp/msi-bin/lease.mjs').href);
  const targets=getTargets||(async()=>{const r=await fetch(cdpUrl+'/json/list');if(!r.ok)throw Error('CDP_TARGET_LIST_FAILED');return(await r.json()).filter(t=>t.type==='page').map(t=>t.id);});
  const result=await api.acquireLease(Number(new URL(cdpUrl).port),'cp-'+process.pid,crypto.randomUUID(),targets,900);
  if(!result.ok)throw Error('WAIT_RESOURCE: '+result.reason);
  const release=()=>api.releaseLease(result.lease);
  release.verify=async()=>{const v=await api.verifyLease(result.lease,targets);if(!v.ok)throw Error('RESOURCE_OWNER_LOST: '+v.reason);};
  return release;
}
export function operationStore(baseDir) {
  const root=path.join(baseDir,'operations');
  const fileFor=key=>path.join(root,digest(String(key))+'.json');
  const validKey=key=>typeof key==='string'&&key.length>0&&key.length<=200;
  return {
    async get(key) { if(!validKey(key))throw Error('IDEMPOTENCY_KEY_REQUIRED');try{return await read(fileFor(key));}catch(e){if(e.code==='ENOENT')return null;throw e;} },
    async reconcile(cmd,operationId,output,proof) {
      if(!validKey(cmd.idempotency_key))throw Error('IDEMPOTENCY_KEY_REQUIRED');
      const file=fileFor(cmd.idempotency_key),current=await read(file);
      if(current.operationId!==operationId||current.payloadHash!==digest({action:cmd.action,params:cmd.params??{}}))throw Error('RECONCILIATION_IDENTITY_MISMATCH');
      const binding=current.effectBinding;
      if(!binding?.targetId||!binding.conversationUrl||binding.targetId!==proof?.targetId||binding.conversationUrl!==proof?.conversationUrl||binding.promptHash!==digest(cmd.params.message)||binding.beforeUserCount!==0||binding.beforeAssistantCount!==0)throw Error('RECONCILIATION_ORIGIN_NOT_BOUND');
      if(current.phase!=='OUTCOME_UNCERTAIN'||!output?.ok||!proof?.conversationUrl||proof.userCount!==1||proof.assistantCount!==1)throw Error('RECONCILIATION_NOT_PROVEN');
      const updated={...current,phase:'SUCCEEDED',output:{...output,operation_id:operationId},reconciledAt:new Date().toISOString(),reconciliation:proof};
      await atomic(file,updated);return updated.output;
    },
    async begin(cmd) {
      if(!validKey(cmd.idempotency_key))throw Error('IDEMPOTENCY_KEY_REQUIRED');
      await fs.mkdir(root,{recursive:true});
      const file=fileFor(cmd.idempotency_key), payloadHash=digest({action:cmd.action,params:cmd.params??{}});
      const rec={schema:'cp-operation/v1',operationId:crypto.randomUUID(),payloadHash,action:cmd.action,phase:'PREPARED',startedAt:new Date().toISOString()};
      let fd;
      try { fd=await fs.open(file,'wx');await fd.writeFile(JSON.stringify(rec));await fd.sync(); }
      catch(e) {
        if(e.code!=='EEXIST')throw e;
        const old=await read(file);
        if(old.payloadHash!==payloadHash)throw Error('IDEMPOTENCY_KEY_REUSED');
        if(old.output)return {cached:{...old.output,replayed:true,operation_id:old.operationId}};
        throw Error('OUTCOME_UNCERTAIN: reconcile operation '+old.operationId+'; submit will not replay');
      } finally { if(fd)await fd.close(); }
      return {
        id:rec.operationId,
        async markAttempt(binding) { rec.phase='EFFECT_ATTEMPTED';if(binding)rec.effectBinding=binding;await atomic(file,rec); },
        async observeConversation(conversationUrl) {
          if(rec.phase!=='EFFECT_ATTEMPTED'||!rec.effectBinding?.targetId||!/^https:\/\/chatgpt\.com\/c\/[a-f0-9-]+$/i.test(conversationUrl))throw Error('CONVERSATION_BINDING_INVALID');
          if(rec.effectBinding.conversationUrl&&rec.effectBinding.conversationUrl!==conversationUrl)throw Error('CONVERSATION_BINDING_CHANGED');
          rec.effectBinding.conversationUrl=conversationUrl;await atomic(file,rec);
        },
        async complete(output) { rec.phase='SUCCEEDED';rec.output={...output,operation_id:rec.operationId};rec.finishedAt=new Date().toISOString();await atomic(file,rec);return rec.output; },
        async fail(output) {
          if(rec.phase==='SUCCEEDED')return;
          rec.phase=rec.phase==='EFFECT_ATTEMPTED'?'OUTCOME_UNCERTAIN':'FAILED_BEFORE_EFFECT';
          rec.finishedAt=new Date().toISOString();
          if(rec.phase==='FAILED_BEFORE_EFFECT')rec.output=output;
          else rec.error=output.error;
          await atomic(file,rec);
        }
      };
    }
  };
}

