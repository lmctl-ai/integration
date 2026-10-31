// Offline, subprocess-only language contracts. CASE_ID selects one durable control.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=realpathSync(mkdtempSync(join(tmpdir(),'lmscript-language-cases-')));
const ctl=process.env.LMCTL_BIN||'lmctl', script=process.env.LMSCRIPT_BIN||'lmscript';
// Allow only runtime plumbing; never inherit credentials, provider homes or Git overrides.
const env={PATH:process.env.PATH,HOME:root,LMCTL_HOME:join(root,'.lmctl'),LMCTL_DB:join(root,'absent','state.db'),
  XDG_CONFIG_HOME:join(root,'.config'),XDG_CACHE_HOME:join(root,'.cache'),XDG_DATA_HOME:join(root,'.local','share'),
  CODEX_HOME:join(root,'.codex'),CLAUDE_CONFIG_DIR:join(root,'.claude'),LMCTL_NO_UPDATE_NOTIFIER:'1',
  LMCTL_NON_INTERACTIVE:'1',LMCTL_TEST_LIVE:'0',TZ:'UTC',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
// These variables belong only to the separate broken-binary control harness.
for(const key of Object.keys(process.env).filter(k=>k.startsWith('FEATURE_')))env[key]=process.env[key];
let passed=0;
const q=JSON.stringify;
function run(bin,args,extra={}) {
  const r=spawnSync(bin,args,{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.signal,null,'unexpected subprocess signal: '+r.stderr);
  return {code:r.status,out:r.stdout,err:r.stderr};
}
function file(name,source){const path=join(root,name+'.lms');writeFileSync(path,source);return path;}
function good(r,out){assert.equal(r.code,0,r.err);if(out!==undefined)assert.equal(r.out,out);return r;}
async function check(id,detects,fn){
  if(process.env.CASE_ID&&process.env.CASE_ID!==id)return;
  try{await fn();passed++;console.log('PASS '+id+' '+detects);}
  catch(error){console.error('FAIL '+id+' '+detects);throw error;}
}
function profile(){
  mkdirSync(env.LMCTL_HOME,{recursive:true});
  const text='Flag = false\nZero = 0\nEmpty = ""\n'+[1,2,3].map(i=>'[Provider'+i+']\nprovider = "ClaudeMock"\nmodel1 = "first"\nmodel2 = "second"\nmodel3 = "third"\n').join('\n');
  const path=join(env.LMCTL_HOME,'init.toml');writeFileSync(path,text);return {path,text};
}
async function signalled(bin,args,signal,expected){
  const child=spawn(bin,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let out='',err='',sent=false;
  const timeout=setTimeout(()=>child.kill('SIGKILL'),30000);
  try{
    const result=await new Promise((accept,reject)=>{
      child.once('error',reject);
      child.stdout.on('data',chunk=>{out+=chunk;if(!sent&&out.split(/\r?\n/).includes('READY')){sent=child.kill(signal);}});
      child.stderr.on('data',chunk=>{err+=chunk;});
      child.once('close',(code,term)=>accept({code,term}));
    });
    assert.equal(sent,true,'signal readiness marker missing: '+err);
    assert.equal(result.term,null,'runner died from signal instead of returning status: '+err);
    assert.equal(result.code,expected,signal+': '+err);
  }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}

try{
  await check('S01','property helpers preserve false/zero/empty, detach copies and keep overlays run-local',()=>{
    const init=profile();
    const p=file('S01-properties','copy = get_properties("Provider1"); copy.Model1 = "copy-only"; old = set_property("Provider1.Model1", "overlay"); println(json_stringify([old, PROPS.Provider1.Model1, PROPS["Provider1.Model1"], get_property("Provider1.model2"), get_property("Flag", true), get_property("Zero", 9), get_property("Empty", "fallback"), has_property("Absent"), get_property("Absent", "fallback"), copy.Model1]));');
    good(run(script,[p]),'["first","overlay","overlay","second",false,0,"",false,"fallback","copy-only"]\n');
    good(run(script,['-e','println(PROPS.Provider1.Model1);']),'first\n');
    assert.equal(readFileSync(init.path,'utf8'),init.text,'overlay wrote the profile');
  });
  await check('S02','strict properties reject readonly aliases; open declarations pass --check and a typo fails at run time, without eager profile reads',()=>{
    profile();
    const readonly=run(script,[file('S02-readonly','view = PROPS.Provider1; view.Model1 = "bad";')]);
    assert.equal(readonly.code,1,readonly.err);assert.match(readonly.err,/read.only/i);
    rmSync(join(env.LMCTL_HOME,'init.toml'));
    // Property declarations are open (overlay-only slots are legal): a typo passes --check and fails at run time.
    const typoFile=file('S02-typo','println(PROPS.Provider1.Modle1);');
    const typo=run(script,['--check',typoFile]);
    assert.equal(typo.code,0,typo.err);
    const typoRun=run(script,[typoFile]);
    assert.equal(typoRun.code,1,typoRun.err);assert.match(typoRun.err,/init\.toml|Modle1/);
    good(run(script,[file('S02-lazy','println(false ? PROPS.Provider1.Model1 : "lazy"); println(PROPS.Directory);')]),'lazy\n'+root+'\n');
    const missing=run(script,[file('S02-missing','println(get_property("Custom", "fallback"));')]);
    assert.equal(missing.code,1,missing.err);assert.match(missing.err,/init.toml/);
  });
  await check('S03','canonical includes execute once and conflicting packages fail before effects',()=>{
    const flat=file('flat','println("flat"); fn plus(a) { return a+1; }');
    symlinkSync(flat,join(root,'flat-link.lms'));
    file('package-a','package sample; value = 4; println("package"); fn add(a) { return a+value; }');
    const p=file('S03-includes','import "./flat.lms"; import "./flat-link.lms"; import "./package-a.lms"; println(sample.add(plus(2)));');
    good(run(script,[p]),'flat\npackage\n7\n');
    file('package-b','package sample; value = 5;');
    const bad=file('S03-duplicate','println("FORBIDDEN"); import "./package-a.lms"; import "./package-b.lms";');
    for(const flags of [[],['--check']]){
      const r=run(script,[...flags,bad]);assert.equal(r.code,2,r.err);assert.equal(r.out,'');
      assert.match(r.err,/package/i);assert.match(r.err,/package-a.lms/);assert.match(r.err,/package-b.lms/);
    }
  });
  await check('S04','compiled native:git preserves spaced paths and exact local status',()=>{
    const repo=join(root,'repo with spaces');mkdirSync(repo);
    const git=(args)=>good(run('git',['-C',repo,...args],{GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}));
    git(['init','--initial-branch=fixture']);
    writeFileSync(join(repo,'tracked file.txt'),'one\ntwo\n');git(['add','.']);
    git(['-c','core.hooksPath=/dev/null','commit','-m','Provide a fixed history for read-only git integration checks']);
    writeFileSync(join(repo,'tracked file.txt'),'one\nchanged\nthree\n');writeFileSync(join(repo,'new file.txt'),'untracked\n');
    const source='import "native:git"; s = git.status(ARGV[0]); println(json_stringify({branch:git.branch(ARGV[0]), status_branch:s.branch, staged:s.staged, unstaged:s.unstaged, untracked:s.untracked, conflicted:s.conflicted, renamed:s.renamed, submodules:s.submodules}));';
    const result=good(run(script,['--no-preflight','-e',source,repo]));
    const expected={branch:'fixture',status_branch:'fixture',staged:[],unstaged:['tracked file.txt'],untracked:['new file.txt'],conflicted:[],renamed:[],submodules:[]};
    const actual=JSON.parse(result.out);assert.deepEqual(actual,expected);
    const broken={...actual,branch:'wrong'};
    assert.throws(()=>assert.deepEqual(broken,expected),'native git branch mutation must fail the S04 assertion');
  });
  await check('S05','nested JSON/object values round-trip and malformed JSON is runtime exit 1',()=>{
    const p=file('S05-json','obj = {name:"fixture", list:[1,false,null,{value:2}]}; println(json_stringify(json_parse(json_stringify(obj))));');
    good(run(script,[p]),'{"name":"fixture","list":[1,false,null,{"value":2}]}\n');
    const bad=file('S05-invalid-json','value = "{broken"; println(json_parse(value));');
    good(run(script,['--check',bad]),'');
    const r=run(script,[bad]);assert.equal(r.code,1,r.err);assert.equal(r.out,'');assert.match(r.err,/JSON|json/);
  });
  await check('S06','check/dry-run recognize no-import host declarations without executing or opening state',()=>{
    rmSync(env.LMCTL_HOME,{recursive:true,force:true});
    const marker=join(root,'S06-effect');
    const p=file('S06-passive','fn unused() { return lm_members("absent.lmctl"); } write_file('+q(marker)+', "effect"); println(PROPS.Provider1.Model1);');
    for(const [bin,prefix] of [[script,[]],[ctl,['script']]])for(const flag of ['--check','--dry-run']){
      const result=good(run(bin,[...prefix,flag,p]));
      if(flag==='--check')assert.equal(result.out,'');
      else {
        assert.match(result.out,/^PLAN needs-real-result\n/);
        assert.match(result.out,/\d+\. .*dummy write_file \[/);
        assert.match(result.out,/S06-effect/);
        // Negative control: the old expectation that dry-run prints nothing must fail.
        assert.throws(()=>assert.equal(result.out,''),'old empty-stdout mutation must fail');
      }
      assert.equal(existsSync(marker),false,'check/dry-run executed write_file');
      assert.equal(existsSync(env.LMCTL_DB),false,'check opened database');assert.equal(existsSync(env.LMCTL_HOME),false,'check created profile');
    }
    const bad=file('S06-unknown-host','lm_not_a_real_builtin();');
    const r=run(script,['--check',bad]);assert.equal(r.code,2,r.err);assert.match(r.err,/lm_not_a_real_builtin/);
  });
  await check('S07','standalone and lmctl shim return offline signal statuses 130 and 143',async()=>{
    const p=file('S07-signal','println("READY"); sleep_ms(60000);');
    for(const [bin,prefix] of [[script,[]],[ctl,['script']]])for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]])await signalled(bin,[...prefix,p],signal,code);
  });
  await check('S08','explicit shim override takes precedence and invalid override cannot silently fall back',()=>{
    const fake=join(root,'explicit-runner.mjs');
    writeFileSync(fake,'#!/usr/bin/env node\n// lmscript-shim-protocol 2\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');chmodSync(fake,0o755);
    const args=['-e','println("not executed");','--','with spaces'];
    const r=good(run(ctl,['script',...args],{LMSCRIPT_BIN:fake}));assert.deepEqual(JSON.parse(r.out),args);
    const missing=run(ctl,['script','-e','println("FALLBACK");'],{LMSCRIPT_BIN:join(root,'missing-runner')});
    assert.equal(missing.code,1,missing.err);assert.equal(missing.out,'');assert.match(missing.err,/LMSCRIPT_BIN.*not an executable/);
    const wrong=join(root,'wrong-protocol.mjs');
    writeFileSync(wrong,'#!/usr/bin/env node\n// lmscript-shim-protocol 999\nconsole.log("FORBIDDEN");\n');chmodSync(wrong,0o755);
    const protocol=run(ctl,['script','-e','println("FALLBACK");'],{LMSCRIPT_BIN:wrong});
    assert.equal(protocol.code,1,protocol.err);assert.equal(protocol.out,'');assert.match(protocol.err,/requires protocol/);
    const unavailable=join(root,'non-executable');writeFileSync(unavailable,'not executable');chmodSync(unavailable,0o600);
    const denied=run(ctl,['script','-e','println("FALLBACK");'],{LMSCRIPT_BIN:unavailable});
    assert.equal(denied.code,1,denied.err);assert.equal(denied.out,'');assert.match(denied.err,/not an executable/);
    // No override: exercise the subject installation's actual workspace/package sibling.
    good(run(ctl,['script','-e','println("SIBLING");']),'SIBLING\n');
  });
  assert.ok(passed,'unknown CASE_ID: '+process.env.CASE_ID);
  console.log(passed+' assertions: '+passed+' pass, 0 fail');
}finally{rmSync(root,{recursive:true,force:true});}
