#!/usr/bin/env node
import {createInterface} from 'node:readline';
const emit=e=>console.log(JSON.stringify(e));const note=(method,params)=>emit({method,params,...(method==='thread/tokenUsage/updated'?{id:JSON.stringify([params.turnId,params.tokenUsage])}:{})});let index=0;
const counter=(i,c,o,r=0)=>({inputTokens:i,cachedInputTokens:c,cacheWriteInputTokens:0,outputTokens:o,reasoningOutputTokens:r});
const usage=(id,last,total)=>({threadId:'s',turnId:id,tokenUsage:{last,total}});
createInterface({input:process.stdin}).on('line',line=>{
 let q;try{q=JSON.parse(line);}catch{return;}if(q.id===undefined)return;
 if(q.method==='turn/interrupt'){emit({id:q.id,result:{}});note('turn/completed',{threadId:'s',turn:{id:q.params.turnId,status:'interrupted'}});return;}
 if(q.method!=='turn/start'){emit({id:q.id,result:q.method.startsWith('thread/')?{thread:{id:'s',turns:[]},model:'gpt-5.6-luna'}:{}});return;}
 const n=++index,id='t'+n;emit({id:q.id,result:{turn:{id}}});
 if(n>1){note('thread/tokenUsage/updated',usage('t1',counter(80,50,6,3),counter(200,120,10,5)));note('turn/completed',{threadId:'s',turn:{id:'t1',status:'completed'}});}
 note('turn/started',{threadId:'s',turn:{id}});
 const first=usage(id,n===1?counter(120,70,4,2):counter(300,200,20,5),n===1?counter(120,70,4,2):counter(500,320,30,10));
 note('thread/tokenUsage/updated',first);note('thread/tokenUsage/updated',first);
 if(q.params.input[0].text==='hang')return;
 if(n===1)note('thread/tokenUsage/updated',usage(id,counter(80,50,6,3),counter(200,120,10,5)));
 note('item/agentMessage/delta',{threadId:'s',turnId:id,delta:'ACK'+n});
 note('turn/completed',{threadId:'s',turn:{id,status:q.params.input[0].text==='fail'?'failed':'completed',error:{message:'injected'}}});
});
