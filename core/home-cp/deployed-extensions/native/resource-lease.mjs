// Resource extension of existing HOME cross-process claims: wx, owner pin, no takeover.
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export async function acquireDesktopClaim(baseDir,binding){
 const root=path.join(baseDir,'claims');await fs.mkdir(root,{recursive:true});
 for(let current=path.resolve(root);;current=path.dirname(current)){if((await fs.lstat(current)).isSymbolicLink())throw Error('RESOURCE_LINK_DENIED');if(path.dirname(current)===current)break;}
 const resource=`desktop:${binding.host}:session:${binding.session_id}`,file=path.join(root,'resource-'+sha(resource)+'.claim.json');
 const record={schema:'cp.resource-lease/v1',resource,owner:crypto.randomUUID(),pid:process.pid,acquired_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString(),binding_sha256:sha(JSON.stringify(binding))},bytes=Buffer.from(JSON.stringify(record));
 let fd;try{fd=await fs.open(file,'wx');await fd.writeFile(bytes);await fd.sync();}catch(e){if(e.code==='EEXIST')throw Error('WAIT_RESOURCE: existing desktop claim requires owner reconciliation');throw e;}finally{await fd?.close();}
 const pin=sha(bytes);async function verify(){const st=await fs.lstat(file);if(st.isSymbolicLink()||st.nlink!==1||sha(await fs.readFile(file))!==pin||Date.now()>=Date.parse(record.expires_at))throw Error('RESOURCE_OWNER_LOST');return true;}
 return {verify,descriptor:{path:file,sha256:pin,expires_at:record.expires_at},async release(){try{if(sha(await fs.readFile(file))===pin)await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
