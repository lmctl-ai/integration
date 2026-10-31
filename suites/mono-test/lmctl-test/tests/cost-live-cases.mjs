// Two explicitly opted-in real turns. Each provider gets private state and credentials.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,chmodSync,existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve as liveResolve } from '../../live-config.mjs';

if(process.env.LMCTL_TEST_LIVE!=='1'){
  console.log('SKIP real Claude/Codex usage turns (set LMCTL_TEST_LIVE=1)');
  console.log('0 assertions: 0 pass, 0 fail');process.exit(0);
}
const bin=process.env.LMCTL_BIN||'lmctl';
const sourceHome=process.env.HOME||homedir();
const sourceClaude=process.env.CLAUDE_CONFIG_DIR||join(sourceHome,'.claude');
const sourceCodex=process.env.CODEX_HOME||join(sourceHome,'.codex');
// the models come from live-config.json (the one place to change them); the env variables still override
const configured=Object.fromEntries(liveResolve(JSON.parse(readFileSync(process.env.LMCTL_LIVE_CONFIG||new URL('../../live-config.json',import.meta.url),'utf8')),{}).map(p=>[p.id,p.model]));
const providers=[['claude',process.env.LMCTL_TEST_LIVE_CLAUDE_MODEL||configured.claude],['codex',process.env.LMCTL_TEST_LIVE_CODEX_MODEL||configured.codex]];
const requested=process.argv[2];
assert.ok(!requested||providers.some(([p])=>p===requested),'optional argument must be claude or codex');
let passed=0;
for(const [provider,model] of providers.filter(([p])=>!requested||p===requested)){
 const root=mkdtempSync(join(tmpdir(),`lmctl-cost-live-${provider}-`));
 try{
  const home=join(root,'home'),state=join(home,'.lmctl'),workspace=join(root,'work'),db=join(root,'state.db'),team=join(workspace,'live.lmctl');
  mkdirSync(state,{recursive:true});mkdirSync(workspace);
  const env={...process.env,HOME:home,LMCTL_HOME:state,LMCTL_DB:db,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),LMCTL_NO_UPDATE_NOTIFIER:'1',LMCTL_NON_INTERACTIVE:'1',TZ:'UTC',LC_ALL:'C'};
  for(const key of Object.keys(env))if(key.startsWith('GIT_')||key.startsWith('CLAUDE_CODE_')||['CLAUDECODE','LMCTL_SELF_SESSIONID','LMCTL_INVOCATION_ID','LMBEE_TEAM_NAME','LMCTL_SELF_TEAMFILE','LMCTL_SELF_ALIAS','LMCTL_ENABLE_MOCK_PROVIDER'].includes(key))delete env[key];
  const credential=provider==='codex'?join(sourceCodex,'auth.json'):join(sourceClaude,'.credentials.json');
  const target=provider==='codex'?join(env.CODEX_HOME,'auth.json'):join(home,'.claude','.credentials.json');
  mkdirSync(provider==='codex'?env.CODEX_HOME:join(home,'.claude'),{recursive:true});
  if(existsSync(credential)){copyFileSync(credential,target);chmodSync(target,0o600);}
  if(provider==='claude')writeFileSync(join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true}));
  const git=spawnSync('git',['init','-q',workspace],{env,encoding:'utf8'});assert.equal(git.status,0,git.stderr);
  writeFileSync(join(state,'init.toml'),[1,2,3].map(i=>`[Provider${i}]\nprovider = "${provider}"\nmodel1 = "${model}"\nmodel2 = "${model}"\nmodel3 = "${model}"\n`).join('\n'));
  writeFileSync(team,`_TEAM_ name=cost-live-${provider}\n_MEMBER_ alias=Lead provider=${provider} model=${model}\n`);
  const run=args=>{const r=spawnSync(bin,args,{env,cwd:workspace,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  run(['seed',team]);
  run(['prompt',team,'Lead','Reply exactly ACK. Do not use tools.','--json']);
  const usage=JSON.parse(run(['usage','--since','2000-01-01','--until','2100-01-01','--json']));
  assert.equal(usage.total.turns,2);assert.equal(usage.total.unknownUsageCount,1);
  assert.ok((usage.total.input??0)+(usage.total.cacheRead??0)+(usage.total.cacheWrite??0)+(usage.total.output??0)>0);
  const database=new DatabaseSync(db,{readOnly:true});let row;
  try{row=database.prepare("SELECT provider,native_session_id,usage_source,cost_usd,provider_cost_usd FROM turn_usage WHERE usage_source IS NOT NULL").get();}finally{database.close();}
  assert.equal(row.provider,provider);assert.ok(row.native_session_id);assert.ok(row.usage_source);
  const session=JSON.parse(run(['cost',row.native_session_id,'--provider',provider,'--json']));
  console.log(`PASS real ${provider} ${model} records usage rows and nonzero tokens`);
  console.log(`COST ${provider}: recorded prompt USD=${row.cost_usd??'unknown'}, provider-reported USD=${row.provider_cost_usd??'unavailable'}, native session including seed USD=${session.costUsd??'unknown'}`);
  passed++;
 }finally{rmSync(root,{recursive:true,force:true});}
}
console.log(`${passed} assertions: ${passed} pass, 0 fail`);
