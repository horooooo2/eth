const {fork}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
function createStatisticsRunner({timeoutMs=60000,heapMb=256}={}) {
  let active,busy=false,generation=0;
  return {
    async run(request) {
      if(busy)throw Error('Statistics computation already running');
      busy=true;const current=generation;let directory,child;
      try {
        directory=await fs.mkdtemp(path.join(os.tmpdir(),'whale-statistics-'));
        if(current!==generation)throw Error('Statistics computation cancelled');
        const output=path.join(directory,'result.db');
        await new Promise((resolve,reject)=>{
          child=fork(path.join(__dirname,'statisticsComputeChild.js'),[],{execArgv:[`--max-old-space-size=${heapMb}`],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
          active=child;let message,timedOut=false;
          const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
          child.on('message',value=>{message=value;});
          child.once('error',error=>{
            // Failed spawn has no open output file. IPC failures after spawn
            // must wait for exit before Windows can remove the private DB.
            if(!child.pid){clearTimeout(timer);reject(error);}
            else {message={ok:false,error:error.message};child.kill();}
          });
          child.once('exit',(code,signal)=>{
            clearTimeout(timer);
            if(timedOut)reject(Error('Statistics computation timed out'));
            else if(current!==generation)reject(Error('Statistics computation cancelled'));
            else if(code===0&&message?.ok)resolve();
            else reject(Error(message?.error||`Statistics process exited (${code??signal})`));
          });
          child.send({...request,output},error=>{if(error){message={ok:false,error:error.message};child.kill();}});
        });
        const result=new Database(output,{readonly:true,fileMustExist:true});
        try {
          // Bound final-result import too; facts never cross this boundary.
          const sizes=result.prepare('SELECT COUNT(*) AS n,MAX(length(CAST(payload_json AS BLOB))) AS max,SUM(length(CAST(payload_json AS BLOB))) AS total FROM results').get();
          if(sizes.n!==9||sizes.max>8*1024*1024||sizes.total>32*1024*1024)throw Error('Statistics result exceeds import budget');
          const meta=JSON.parse(result.prepare('SELECT payload_json FROM metadata').get().payload_json);
          const rows=[];
          for(const row of result.prepare('SELECT * FROM results').iterate()) {
            rows.push(row);await new Promise(resolve=>setImmediate(resolve));
            if(current!==generation)throw Error('Statistics computation cancelled');
          }
          return {meta,rows};
        } finally {result.close();}
      } finally {
        if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
        active=null;busy=false;
        if(directory&&path.dirname(directory)===path.resolve(os.tmpdir()))await fs.rm(directory,{recursive:true,force:true});
      }
    },
    stop(){generation++;active?.kill();},
  };
}
module.exports={createStatisticsRunner};
