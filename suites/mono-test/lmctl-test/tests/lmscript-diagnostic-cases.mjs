// Offline CLI contracts for the recently merged LMScript diagnostics.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=mkdtempSync(join(tmpdir(),'lmctl-script-diagnostics-'));
const bin=process.env.LMCTL_BIN||'lmctl';
const scriptBin=process.env.LMSCRIPT_BIN||'lmscript';
const env={...process.env,HOME:root,LMCTL_HOME:join(root,'.lmctl'),LMCTL_NO_UPDATE_NOTIFIER:'1',LMCTL_DB:join(root,'state.db'),TZ:'UTC',LC_ALL:'C'};
let passed=0;
function check(name,fn){fn();passed++;console.log(`PASS ${name}`);}
function run(args){const r=spawnSync(bin,args,{env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});if(r.error)throw r.error;return{code:r.status,out:r.stdout||'',err:r.stderr||''};}
function sourceCheck(name,src,expected,code=2){const file=join(root,name+'.lms');writeFileSync(file,src);const r=run(['script','--check',file]);assert.equal(r.code,code,r.out+r.err);assert.match(r.err,expected,r.out+r.err);}
function expectHint(text,pattern){assert.match(text,pattern);}
try {
  check('import without alias explains literal include and package declaration',()=>sourceCheck('import-no-as','import "fixture.lms" as package_name;\n',/`as` is only supported for schema modules.*a source module's namespace is its package declaration/));
  check('literal expand with a missing map key is rejected during check',()=>sourceCheck('expand-missing','expand("hello ${who}", {there: 1});\n',/expand: missing references: who \(not defined\)/));
  check('expand allows runtime-built maps and dynamic templates',()=>{
    const file=join(root,'expand-dynamic.lms');writeFileSync(file,'vars = {who: "world"}; template = "hello ${who}"; println(expand(template, vars));\n');
    const r=run(['script','--check',file]);assert.equal(r.code,0,r.out+r.err);
    const executed=run(['script',file]);assert.equal(executed.code,0,executed.err);assert.equal(executed.out,'hello world\n');
  });
  check('removed regex_split name suggests split_regex',()=>sourceCheck('regex-split','regex_split("a,b", ",");\n',/split_regex/));
  check('literal templates allow function-built maps and imported package functions',()=>{
    writeFileSync(join(root,'expand-module.lms'),'package expansion; fn greet() { return expand("hello ${who}", {who: "world"}); }\n');
    const file=join(root,'expand-imported.lms');
    writeFileSync(file,'import "./expand-module.lms"; fn vars() { return {who: "world"}; } println(expand("hello ${who}", vars())); println(expansion.greet());\n');
    const checked=run(['script','--check',file]);assert.equal(checked.code,0,checked.err);
    const executed=run(['script',file]);assert.equal(executed.code,0,executed.err);assert.equal(executed.out,'hello world\nhello world\n');
  });
  check('nonliteral missing references fail at runtime rather than check time',()=>{
    const file=join(root,'expand-runtime-missing.lms');writeFileSync(file,'template = "hello ${who}"; println(expand(template, {there: 1}));\n');
    const checked=run(['script','--check',file]);assert.equal(checked.code,0,checked.err);
    const executed=run(['script',file]);assert.equal(executed.code,1,executed.err);assert.match(executed.err,/missing references: who/);
  });
  check('canonical split_regex runs and a user function may use the removed name',()=>{
    const file=join(root,'regex-canonical.lms');writeFileSync(file,'println(json_stringify(split_regex("a,b", ","))); fn regex_split(a,b) { return "local"; } println(regex_split("x", "y"));\n');
    const checked=run(['script','--check',file]);assert.equal(checked.code,0,checked.err);
    const executed=run(['script',file]);assert.equal(executed.code,0,executed.err);assert.equal(executed.out,'["a","b"]\nlocal\n');
  });
  check('help lists operator topics and runner options',()=>{
    const h=spawnSync(scriptBin,['--help'],{env,encoding:'utf8',timeout:30000});assert.equal(h.status,0,h.stderr);assert.match(h.stdout,/--check-files/);assert.match(h.stdout,/--base-dir/);assert.match(h.stdout,/--source-name/);
    const topics=spawnSync(scriptBin,['help','topics'],{env,encoding:'utf8',timeout:30000});assert.equal(topics.status,0,topics.stderr);assert.match(topics.stdout,/conditional/);assert.match(topics.stdout,/regex/);
  });
  // Failing controls use an intentionally wrong diagnostic oracle and a valid source under a negative oracle.
  check('diagnostic controls reject a wrong expected hint and reject false positives',()=>{
    const file=join(root,'control.lms');writeFileSync(file,'regex_split("a,b", ",");\n');const r=run(['script','--check',file]);
    assert.equal(r.code,2);expectHint(r.err,/split_regex/);
    assert.throws(()=>expectHint(r.err.replace('split_regex','removed'),/split_regex/),'mutated hint must fail the hint oracle');
    writeFileSync(file,'value = 1;\n');const valid=run(['script','--check',file]);assert.equal(valid.code,0,valid.out+valid.err);
    assert.throws(()=>assert.equal(valid.code,2),'valid control must fail a broken blanket-rejection oracle');
  });
  console.log(`${passed} assertions: ${passed} pass, 0 fail`);
} finally { rmSync(root,{recursive:true,force:true}); }
