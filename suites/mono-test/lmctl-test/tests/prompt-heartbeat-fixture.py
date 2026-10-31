#!/usr/bin/env python3
import json
import os
import pty
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n'); sys.stdout.flush()

def prepare(root, delay_ms):
    root=Path(root); home=root/'home'; lmhome=root/'lmctl-home'; workspace=root/'workspace'; lead=workspace/'lead'
    home.mkdir(parents=True); lmhome.mkdir(parents=True); workspace.mkdir(parents=True); lead.mkdir(parents=True)
    (lmhome/'init.toml').write_text('[Provider1]\nprovider = "ClaudeMock"\nmodel1 = "mock-default"\nmodel2 = "mock-default"\nmodel3 = "mock-default"\n')
    sid='heartbeat-session'; caller_sid='caller-session'; team=workspace/'heartbeat.lmctl'; team.write_text('_TEAM_ name=heartbeat\n_MEMBER_ alias=Lead provider=ClaudeMock model=mock-default sessionid='+sid+' sessiondir='+str(lead)+'\n_MEMBER_ alias=Caller provider=ClaudeMock sessionid='+caller_sid+' sessiondir='+str(workspace)+'\n')
    stamp='2026-10-09T00:00:00.000Z'; store=root/'claudemock.json'
    store.write_text(json.dumps({'schemaVersion':1,'defaultDelayMs':delay_ms,'sessions':{caller_sid:{'sessionId':caller_sid,'cwd':str(workspace),'filePath':str(store),'createdAt':stamp,'modifiedAt':stamp,'messages':[],'totalInputTokens':0,'totalOutputTokens':0},sid:{'sessionId':sid,'cwd':str(lead),'filePath':str(store),'createdAt':stamp,'modifiedAt':stamp,'messages':[],'totalInputTokens':0,'totalOutputTokens':0}},'scriptContains':{'HEARTBEAT_OK':{'text':'HEARTBEAT_OK','delayMs':delay_ms}}}))
    return {'home':str(home),'lmctl_home':str(lmhome),'workspace':str(workspace),'team':str(team),'store':str(store),'db':str(root/'state.db'),'session':caller_sid}

def env_for(meta, agent):
    env={'PATH':os.environ['PATH'],'NODE_NO_WARNINGS':'1','TZ':'UTC','LC_ALL':'C'};env.update({'HOME':meta['home'],'LMCTL_HOME':meta['lmctl_home'],'LMCTL_DB':meta['db'],'LMCTL_ENABLE_MOCK_PROVIDER':'1','LMCTL_CLAUDE_MOCK_STORE':meta['store'],'LMCTL_NO_UPDATE_NOTIFIER':'1'})
    if agent: env['LMCTL_SELF_SESSIONID']=meta['session'];env['LMCTL_STALL_THRESHOLD_MS']='100'
    else: env.pop('LMCTL_SELF_SESSIONID',None);env.pop('LMCTL_STALL_THRESHOLD_MS',None);env.pop('LMCTL_NON_INTERACTIVE',None)
    return env

def run_child(argv,env,cwd,timeout=30):
    # stdout stays separate; real stderr is a PTY so the agent marker, rather
    # than pipe detection, must suppress the elapsed heartbeat.
    master,slave=pty.openpty()
    child=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=slave,start_new_session=True)
    os.close(slave);chunks=[];deadline=time.monotonic()+timeout;expired=False
    try:
        while time.monotonic()<deadline:
            ready,_,_=select.select([master],[],[],.1)
            if ready:
                try: data=os.read(master,65536)
                except OSError: break
                if not data: break
                chunks.append(data)
            if child.poll() is not None and not ready: break
        else: expired=True;child.terminate()
        try: out,_=child.communicate(timeout=5)
        except subprocess.TimeoutExpired: child.kill();out,_=child.communicate();expired=True
        return {'pid':child.pid,'code':child.returncode,'stdout':out.decode(),'stderr':b''.join(chunks).decode(),'timed_out':expired,'stderr_is_pty':True}
    finally:
        os.close(master)
        if child.poll() is None: child.kill();child.wait()

def pty_child(argv,env,cwd,timeout=30):
    # Use the standard PTY runner while recording its actual child PID.
    chunks=[];owned=[None];expired=[False];original_fork=pty.fork
    saved_env=dict(os.environ);saved_cwd=os.getcwd();saved_stdout=os.dup(1)
    prior_alarm=signal.getsignal(signal.SIGALRM)
    def tracked_fork():
        pid,fd=original_fork()
        if pid: owned[0]=pid
        return pid,fd
    def capture(fd):
        data=os.read(fd,65536);chunks.append(data);return data
    def deadline(signum,frame):
        expired[0]=True
        if owned[0]:
            try: os.kill(owned[0],signal.SIGTERM)
            except ProcessLookupError: pass
    try:
        os.environ.clear();os.environ.update(env);os.chdir(cwd)
        with open(os.devnull,'wb') as sink: os.dup2(sink.fileno(),1)
        pty.fork=tracked_fork;signal.signal(signal.SIGALRM,deadline);signal.alarm(timeout)
        status=pty.spawn(argv,master_read=capture,stdin_read=lambda fd:b'')
        return {'pid':owned[0],'code':os.waitstatus_to_exitcode(status),'output':b''.join(chunks).decode(),'timed_out':expired[0]}
    finally:
        signal.alarm(0);signal.signal(signal.SIGALRM,prior_alarm);pty.fork=original_fork
        os.dup2(saved_stdout,1);os.close(saved_stdout);os.chdir(saved_cwd)
        os.environ.clear();os.environ.update(saved_env)

def main():
    mode=sys.argv[1];root=Path(tempfile.mkdtemp(prefix='lmctl-prompt-heartbeat-'));meta=prepare(root,11500);lmctl=os.environ['LMCTL_BIN']
    try:
        env=env_for(meta,mode=='agent');result=pty_child([lmctl,'prompt',meta['team'],'Lead','HEARTBEAT_OK'],env,meta['workspace']) if mode=='pty' else run_child([lmctl,'prompt',meta['team'],'Lead','HEARTBEAT_OK'],env,meta['workspace'])
        usage=subprocess.run([lmctl,'usage','--since','2000-01-01','--until','2100-01-01','--by','session','--json'],cwd=meta['workspace'],env=env,text=True,capture_output=True,timeout=60)
        store=json.loads(Path(meta['store']).read_text())
        emit({'meta':meta,'result':result,'usage':{'code':usage.returncode,'stdout':usage.stdout,'stderr':usage.stderr},'store':store});return 0
    finally: shutil.rmtree(root,ignore_errors=True)

if __name__=='__main__': raise SystemExit(main())
