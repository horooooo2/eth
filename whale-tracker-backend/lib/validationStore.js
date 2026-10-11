const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const TTL = 86400000;
function createValidationStore(directory, now = Date.now) {
  const valid = job => job && typeof job.id === 'string' && typeof job.coin === 'string' && typeof job.owner === 'string' && ['complete','partial'].includes(job.status) && Number.isFinite(job.finishedAt) && now()-job.finishedAt<TTL && Array.isArray(job.positions) && job.positions.length<=2000;
  return {
    async load() {
      await fs.mkdir(directory,{recursive:true});
      const jobs=[];
      for (const name of await fs.readdir(directory)) {
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const file=path.join(directory,name);
        try {
          if((await fs.stat(file)).size>4*1024*1024)continue;
          const job=JSON.parse(await fs.readFile(file,'utf8'));
          if(valid(job))jobs.push(job);
          else await fs.unlink(file);
        } catch(err) { console.warn('[validation-store] snapshot unreadable:',name,err.code||err.message); }
      }
      return jobs.sort((a,b)=>a.finishedAt-b.finishedAt);
    },
    async save(job) {
      if(!valid(job))throw new Error('Invalid validation snapshot');
      await fs.mkdir(directory,{recursive:true});
      const file=path.join(directory,createHash('sha256').update(job.coin.toUpperCase()).digest('hex')+'.json');
      const temp=file+'.'+randomUUID()+'.tmp';
      try { await fs.writeFile(temp,JSON.stringify(job),{encoding:'utf8',mode:0o600});await fs.rename(temp,file); }
      finally { await fs.unlink(temp).catch(()=>{}); }
    },
  };
}
module.exports={createValidationStore};
