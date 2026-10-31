// Deliberately broken CLI output, not a replacement implementation of its logic.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'feature-case-controls-'));
const real=process.env.LMCTL_BIN||'lmctl',script=process.env.LMSCRIPT_BIN||'lmscript';
const helper=name=>fileURLToPath(new URL('./'+name,import.meta.url));
let passed=0;
try {
  const wrapper=join(root,'broken-cli.mjs');
  writeFileSync(wrapper,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const mode=process.env.FEATURE_MUTATION,args=process.argv.slice(2);
if(mode==='failed-binary')process.exit(1);
if(mode==='language-signal'){
 process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
 setInterval(()=>{},1000);console.log('READY');await new Promise(()=>{});
}
if(mode==='language-notready'){
 process.on('SIGINT',()=>process.exit(130));process.on('SIGTERM',()=>process.exit(143));
 console.log('NOTREADY');setTimeout(()=>process.exit(0),25);await new Promise(()=>{});
}
const target=['script','seed','prompt','usage','cost'].includes(args[0])?process.env.FEATURE_REAL_BIN:process.env.FEATURE_REAL_SCRIPT_BIN;
if(mode==='language-passive'&&args.includes('--dry-run'))args.splice(args.indexOf('--dry-run'),1);
const r=spawnSync(target,args,{env:process.env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
if(r.error)throw r.error;
let out=r.stdout||'',err=r.stderr||'',code=r.status??1;
if(args.includes('--json')&&code===0){
 const p=JSON.parse(out);
 if(args[0]==='usage'){
  if(mode==='usage-cost'&&p.total.costUsd!==null)p.total.costUsd+=.000001;
  if(mode==='group-cost')for(const g of p.groups)if(g.costUsd!==null)g.costUsd+=.000001;
  if(mode==='unknown-reason')delete p.reasons.usage.native_record_missing;
  if(mode==='wire-cache'&&process.env.LMCTL_DB.includes('wire-missing-rate'))p.total.cacheRead=0;
  if(mode==='usage-empty')p.total.turns=1;
  if(mode==='usage-days'&&p.by==='day')p.groups[0].key='1900-01-01';
 }
 if(args[0]==='cost'){
  if(mode==='claude-dedup'&&args[1].startsWith('11111111'))p.tokens.input*=2;
  if(mode==='inclusive-cache'&&args.includes('gemini'))p.costUsd+=p.tokens.cachedInput/1e6;
  if(mode==='reset-cost'&&args[1].startsWith('33333333'))p.costUsd*=2;
  if(mode==='missing-rate'&&p.costUsd===null)p.costUsd=0;
  if(mode==='copilot-shutdown'&&args.includes('copilot'))p.tokens.output+=10;
 }
 out=JSON.stringify(p)+'\\n';
}
if(mode==='hint')err=err.replaceAll('split_regex','another_name');
if(mode==='literal-message'&&args.some(a=>a.endsWith('expand-missing.lms')))err='generic error containing who\\n';
if(mode==='dynamic-refusal'&&args.includes('--check')&&args.some(a=>a.endsWith('expand-dynamic.lms'))){code=2;err='injected false positive\\n';}
if(mode==='help-flag'&&args.includes('--help'))out=out.replaceAll('--source-name','--wrong-name');
if(mode==='usage-validation'&&args[0]==='usage'&&code===2)code=0;
if(mode==='language-properties'&&args.some(a=>a.endsWith('S01-properties.lms')))out=out.replaceAll('"overlay"','"lost"');
if(mode==='language-readonly'&&args.some(a=>a.endsWith('S02-readonly.lms'))){code=0;err='';}
if(mode==='language-packages'&&args.some(a=>a.endsWith('S03-duplicate.lms'))){code=0;err='';}
if(mode==='language-git'&&args.some(a=>a.endsWith('S04-git.lms'))&&code===0){const p=JSON.parse(out);p.added++;out=JSON.stringify(p)+'\\n';}
if(mode==='language-json'&&!args.includes('--check')&&args.some(a=>a.endsWith('S05-invalid-json.lms'))){code=0;err='';}
if(mode==='language-override'&&process.env.LMSCRIPT_BIN?.endsWith('explicit-runner.mjs'))out='[]\\n';
process.stdout.write(out);process.stderr.write(err);process.exit(code);
`);
  chmodSync(wrapper,0o755);
  function control(mode,suite,extra={}){
    const result=spawnSync(process.execPath,[helper(suite)],{
      env:{...process.env,LMCTL_TEST_LIVE:'0',FEATURE_MUTATION:mode,FEATURE_REAL_BIN:real,FEATURE_REAL_SCRIPT_BIN:script,LMCTL_BIN:wrapper,LMSCRIPT_BIN:script,...extra},
      encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,
    });
    if(result.error)throw result.error;
    assert.notEqual(result.status,0,mode+' survived');
    assert.match(result.stderr,/AssertionError/,mode+': unrelated failure: '+result.stderr);
    if(extra.CASE_ID)assert.match(result.stderr,new RegExp('FAIL '+extra.CASE_ID+' '),mode+': wrong case failed');
    if(mode==='help-flag')assert.match(result.stdout,/PASS canonical split_regex/, 'help control failed before reaching help');
    console.log('PASS rejected '+mode);passed++;
  }
  for(const mode of ['failed-binary','usage-cost','group-cost','unknown-reason','claude-dedup','inclusive-cache','reset-cost','missing-rate','wire-cache'])control(mode,'cost-feature-cases.mjs');
  for(const mode of ['failed-binary','hint','literal-message','dynamic-refusal'])control(mode,'lmscript-diagnostic-cases.mjs');
  control('help-flag','lmscript-diagnostic-cases.mjs',{LMSCRIPT_BIN:wrapper});
  control('failed-binary','cost-live-cases.mjs',{LMCTL_TEST_LIVE:'1',HOME:root,CODEX_HOME:join(root,'unused-codex'),CLAUDE_CONFIG_DIR:join(root,'unused-claude')});
  const skipped=spawnSync(process.execPath,[helper('cost-live-cases.mjs')],{env:{...process.env,LMCTL_TEST_LIVE:'0',LMCTL_BIN:wrapper,FEATURE_MUTATION:'failed-binary'},encoding:'utf8'});
  assert.equal(skipped.status,0,skipped.stderr);assert.match(skipped.stdout,/0 assertions: 0 pass, 0 fail/);
  console.log('PASS live guard does not invoke a binary when disabled');passed++;
  for(const [id,mode] of [['U01','usage-empty'],['U02','usage-validation'],['U03','usage-days'],['U04','copilot-shutdown']]){
    control(mode,'usage-boundary-cases.mjs',{CASE_ID:id});
  }
  for(const [id,mode] of [['S01','language-properties'],['S02','language-readonly'],['S03','language-packages'],['S04','language-git'],['S05','language-json'],['S06','language-passive'],['S07','language-signal'],['S08','language-override']]){
    const extra={CASE_ID:id,LMSCRIPT_BIN:wrapper};
    if(id==='S04'){
      const binary=script.includes('/')?script:(process.env.PATH||'').split(':').map(p=>join(p,script)).find(existsSync);
      extra.LMSCRIPT_GIT_MODULE=process.env.LMSCRIPT_GIT_MODULE||join(dirname(dirname(realpathSync(binary))),'modules','git.lms');
    }
    control(mode,'lmscript-language-cases.mjs',extra);
  }
  control('language-notready','lmscript-language-cases.mjs',{CASE_ID:'S07',LMSCRIPT_BIN:wrapper});
  console.log(passed+' controls: '+passed+' pass, 0 fail');
} finally {rmSync(root,{recursive:true,force:true});}
