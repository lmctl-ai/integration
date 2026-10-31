// Fixture/process transport only. Assertions belong to native-session.lms.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const [action,rootOrMode,frontend,file]=process.argv.slice(2);
const lmctl=process.env.LMCTL_BIN;
const language=process.env.LMSCRIPT_BIN;
if(!lmctl||!language)throw Error('LMCTL_BIN and LMSCRIPT_BIN are required');
function prepare(mode){
 const root=mkdtempSync(join(tmpdir(),'it-native-session-'));
 const home=join(root,'home'),workspace=join(root,'workspace'),bin=join(root,'bin');
 for(const dir of [home,workspace,bin,join(home,'.lmctl')])mkdirSync(dir,{recursive:true});
 const sid='11111111-1111-4111-8111-111111111111',caller='22222222-2222-4222-8222-222222222222';
 const store=join(root,'mock.json'),database=join(root,'state.db'),team=join(workspace,'team.lmctl'),trace=join(root,'trace.jsonl');
 const stamp=new Date().toISOString();
 const session=id=>({sessionId:id,cwd:workspace,filePath:store,createdAt:stamp,modifiedAt:stamp,messages:[],totalInputTokens:0,totalOutputTokens:0});
 writeFileSync(store,JSON.stringify({schemaVersion:1,sessions:{[sid]:session(sid),[caller]:session(caller)},script:{ONE:'FIRST_REPLY',FIRST_REPLY:'SECOND_REPLY',PROBE:'UNLOCKED'},scriptContains:{PROBE:'UNLOCKED'}}));
 const provider=mode==='agy'?'agy':'ClaudeMock';
 writeFileSync(team,'_MEMBER_ alias=Lead provider='+provider+' sessionid='+sid+' sessiondir='+workspace+'\n_MEMBER_ alias=Caller provider=ClaudeMock sessionid='+caller+' sessiondir='+workspace+'\n');
 writeFileSync(join(home,'.lmctl','init.toml'),'[Provider1]\nprovider="ClaudeMock"\nmodel1="mock-default"\nmodel2="mock-default"\nmodel3="mock-default"\n');
 const prices=join(root,'prices');mkdirSync(prices);
 writeFileSync(join(prices,'model_list.json'),JSON.stringify({schema_version:1,records:[]}));
 writeFileSync(join(prices,'aliases.json'),JSON.stringify({schema_version:1,standards:[],aliases:[]}));
 if(mode==='agy'){
  const data=join(home,'.gemini','antigravity-cli');
  mkdirSync(join(data,'conversations'),{recursive:true});mkdirSync(join(data,'brain',sid,'.system_generated','logs'),{recursive:true});
  writeFileSync(join(data,'conversations',sid+'.db'),'fixture');
  writeFileSync(join(data,'brain',sid,'.system_generated','logs','transcript.jsonl'),'');
  const fixture=new URL('./fixtures/native-session-print.mjs',import.meta.url);
  writeFileSync(join(bin,'agy'),'#!/usr/bin/env node\nimport '+JSON.stringify(fixture.href)+';\n',{mode:0o755});
 }
 const env={PATH:bin+':'+process.env.PATH,HOME:home,LMCTL_HOME:join(home,'.lmctl'),LMCTL_DB:database,LMCTL_ENABLE_MOCK_PROVIDER:'1',LMCTL_CLAUDE_MOCK_STORE:store,LMCTL_PRICE_DATA:prices,LMCTL_NO_UPDATE_NOTIFIER:'1',LMCTL_NON_INTERACTIVE:'1',NODE_NO_WARNINGS:'1',TZ:'UTC',LC_ALL:'C',CONVERSATION_PROTOCOL:'print',CONVERSATION_SID:sid,CONVERSATION_TRACE:trace};
 const meta={root,home,workspace,store,database,team,trace,sid,caller,provider,env};
 writeFileSync(join(root,'meta.json'),JSON.stringify(meta));return meta;
}
function run(meta,command,args,extra={}){
 const r=spawnSync(process.execPath,[command,...args],{cwd:meta.workspace,env:{...meta.env,...extra},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 if(r.error)throw r.error;
 return {code:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr};
}
function scriptArgs(front,path){return front==='lmctl'?['script',path]:[path];}
const binary=front=>front==='lmctl'?lmctl:language;
function trace(meta){return existsSync(meta.trace)?readFileSync(meta.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
function usage(meta){return run(meta,lmctl,['usage','--since','2000-01-01','--until','2100-01-01','--by','session','--json']);}
async function held(meta,front,holderFile,probeFile){
 const child=spawn(process.execPath,[binary(front),...scriptArgs(front,holderFile)],{cwd:meta.workspace,env:meta.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const ended=new Promise((resolveEnd,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolveEnd({code,signal,stdout,stderr}));});
 try{
  const until=Date.now()+15000;
  while(!stdout.includes('READY\n')&&child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  if(!stdout.includes('READY\n'))throw Error('holder readiness failed: '+stdout+stderr);
  const second=run(meta,binary(front),scriptArgs(front,probeFile));
  const agent=run(meta,lmctl,['prompt',meta.team,'Lead','PROBE','--json'],{LMCTL_SELF_SESSIONID:meta.caller});
  child.kill('SIGTERM');const holder=await ended;
  const reopened=run(meta,binary(front),scriptArgs(front,probeFile));
  return {pid:child.pid,holder,second,agent,reopened,usage:usage(meta),store:JSON.parse(readFileSync(meta.store,'utf8'))};
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await ended;}
 }
}
let result;
if(action==='prepare')result=prepare(rootOrMode);
else if(action==='remove'){rmSync(rootOrMode,{recursive:true,force:true});result={removed:!existsSync(rootOrMode)};}
else{
 const meta=JSON.parse(readFileSync(join(rootOrMode,'meta.json'),'utf8'));
 if(action==='run')result={result:run(meta,binary(frontend),scriptArgs(frontend,file)),usage:usage(meta),store:JSON.parse(readFileSync(meta.store,'utf8')),trace:trace(meta)};
 else if(action==='dry'){const before=existsSync(meta.database);result={result:run(meta,binary(frontend),frontend==='lmctl'?['script','--dry-run','--plan-format','json',file]:['--dry-run','--plan-format','json',file]),before,databaseExists:existsSync(meta.database),store:JSON.parse(readFileSync(meta.store,'utf8')),trace:trace(meta)};}
 else if(action==='held')result=await held(meta,frontend,file,process.argv[6]);
 else if(action==='probe')result={result:run(meta,lmctl,['prompt',meta.team,'Lead','PROBE','--json']),usage:usage(meta)};
 else throw Error('unknown transport action '+action);
}
console.log(JSON.stringify(result));
