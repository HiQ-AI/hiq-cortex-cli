"""Exercise fail-closed publication and cleanup with a fake transport; no network."""
import os, tempfile, pathlib, subprocess, json, hashlib, base64, datetime
root=pathlib.Path(tempfile.mkdtemp()); bindir=root/'bin';bindir.mkdir()
scripts=pathlib.Path(__file__).resolve().parent
mock='''#!/usr/bin/env python3
import os,sys,json,pathlib
root=pathlib.Path(os.environ['MOCK_DB']);s=json.loads((root/'state').read_text());a=sys.argv[1:]
with (root/'calls').open('a') as f:f.write(json.dumps([pathlib.Path(sys.argv[0]).name,*a])+'\\n')
if pathlib.Path(sys.argv[0]).name=='git':
 if s.get('git_status',0):sys.exit(s['git_status'])
 if a==['rev-parse','HEAD']:print(os.environ['GITHUB_SHA'])
 elif a==['status','--porcelain']:print(s.get('dirty',''))
 sys.exit(0)
if pathlib.Path(sys.argv[0]).name=='npm':
 if a[0]=='publish':sys.exit(s.get('publish_status',0))
 print(json.dumps(s.get('npm',{})));sys.exit(s.get('npm_status',0))
if a[:2]==['release','create']:
 if s.get('create_error'):sys.exit(1)
 s['release']={'id':42,'tag_name':'v1.0.0','draft':False,'prerelease':False};(root/'state').write_text(json.dumps(s));sys.exit(0)
if '-X' in a and 'DELETE' in a:sys.exit(0)
if s.get('lookup_error'):sys.exit(1)
endpoint=a[1]
if '/actions/runs/' in endpoint:print(json.dumps(s['run']))
elif '/assets/' in endpoint:sys.stdout.buffer.write(s.get('asset_bytes','candidate').encode())
elif '/assets?' in endpoint:print(json.dumps([s['assets']]))
elif '/releases?' in endpoint:print(json.dumps([[s['release']] if s.get('release') else []]))
else:print(json.dumps(s['release']))
'''
for name in ['gh','npm','git']:
 p=bindir/name;p.write_text(mock);p.chmod(0o755)
(root/'package.json').write_text(json.dumps({'name':'@hiq-ai/test','version':'1.0.0'}))
file=root/'candidate.tgz';file.write_text('candidate')
env={**os.environ,'PATH':str(bindir)+':'+os.environ['PATH'],'MOCK_DB':str(root),'GITHUB_REPOSITORY':'HiQ-AI/test','GITHUB_REF_NAME':'v1.0.0'}
base={'release':{'id':42,'tag_name':'v1.0.0','draft':False,'prerelease':False},'assets':[{'id':1,'name':file.name,'size':9}]}
def run(script,state,args,ok=True):
 (root/'state').write_text(json.dumps(state));(root/'calls').write_text('')
 r=subprocess.run(['node',str(scripts/script),*args],env=env,cwd=root,capture_output=True,text=True)
 assert (r.returncode==0)==ok, r.stderr
 return [json.loads(l) for l in (root/'calls').read_text().splitlines()]
def no_write(calls):
 assert not any(c[1:3]==['release','create'] or 'upload' in c or 'DELETE' in c or c[1:2]==['publish'] for c in calls),calls
# Public Release: identical replay, new release, conflict and all transport failures.
no_write(run('release-publish.mjs',base,[str(file)]))
calls=run('release-publish.mjs',{**base,'release':None},[str(file)]);assert sum(c[1:3]==['release','create'] for c in calls)==1
for changes in [{'asset_bytes':'different'},{'assets':[]},{'assets':base['assets']+[{'id':2,'name':'extra','size':1}]},{'lookup_error':True},{'release':{**base['release'],'draft':True}}]:
 no_write(run('release-publish.mjs',{**base,**changes},[str(file)],False))
calls=run('release-publish.mjs',{**base,'release':None,'create_error':True},[str(file)],False)
assert not any('upload' in c for c in calls)
# npm: exact bytes can replay; only E404 may publish. Errors/conflicts never publish.
if (scripts/'npm-publish.mjs').exists():
 dist={'shasum':hashlib.sha1(file.read_bytes()).hexdigest(),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(file.read_bytes()).digest()).decode()}
 no_write(run('npm-publish.mjs',{'npm':dist},[str(file)]))
 calls=run('npm-publish.mjs',{'npm_status':1,'npm':{'error':{'code':'E404'}}},[str(file)])
 assert sum(c[1:2]==['publish'] for c in calls)==1
 for state in [{'npm':{**dist,'shasum':'wrong'}},{'npm':{**dist,'integrity':'wrong'}},{'npm_status':1,'npm':{'error':{'code':'E503'}}},{'npm_status':1,'npm':{'error':{'code':'E401'}}}]:
  no_write(run('npm-publish.mjs',state,[str(file)],False))
# The active release is CDN-only: no tags, GitHub release/draft transfer or npm publication.
workflow=scripts.parent/'workflows/release.yml';text=workflow.read_text()
assert 'workflow_dispatch:' in text and 'contents: read' in text
for forbidden in ['push:', 'tags:', 'contents: write', 'release-publish.mjs', 'release-handoff.mjs', 'npm-publish.mjs', 'npm pack --', 'id-token:']:
 assert forbidden not in text,forbidden
assert text.index('node scripts/check-native.mjs') < text.index('./scripts/publish-cdn.sh')
assert 'node .github/scripts/verify-release.mjs' in text
for ref,sha,status,dirty,ok in [('main','a'*40,0,'',True),('v0.5.1','a'*40,0,'',False),('main','bad',0,'',False),('main','a'*40,1,'',False),('main','a'*40,0,' M src/cli.ts',False)]:
 (root/'state').write_text(json.dumps({'git_status':status,'dirty':dirty}));(root/'calls').write_text('')
 guard_env={**env,'GITHUB_REF_NAME':ref,'GITHUB_SHA':sha}
 r=subprocess.run(['node',str(scripts/'verify-release.mjs')],env=guard_env,cwd=root,capture_output=True,text=True)
 assert (r.returncode==0)==ok,r.stderr
 no_write([json.loads(line) for line in (root/'calls').read_text().splitlines()])
# Manual cleanup: default is read-only; namespace/state/age gate every deletion.
def ago(days):return (datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=days)).isoformat()
identity={'repository':'HiQ-AI/test','run':'123','attempt':'1','sha':'a'*40,'kind':'binaries'}
release={'id':42,'draft':True,'tag_name':'ci-transfer-123-1-binaries','body':json.dumps(identity),'created_at':ago(8),'assets':[]}
run_info={'head_sha':'a'*40,'path':'.github/workflows/release.yml','status':'completed','updated_at':ago(8),'run_attempt':1,'conclusion':'success'}
state={'release':release,'run':run_info}
no_write(run('release-handoff-cleanup.mjs',state,['42']))
calls=run('release-handoff-cleanup.mjs',state,['42','--apply']);assert sum('DELETE' in c for c in calls)==1
for changed in [{'release':{**release,'draft':False}},{'release':{**release,'created_at':ago(1)}},{'release':{**release,'tag_name':'v1.0.0'}},{'run':{**run_info,'status':'in_progress'}},{'run':{**run_info,'updated_at':ago(1)}},{'run':{**run_info,'head_sha':'b'*40}},{'run':{**run_info,'conclusion':'failure'}}]:
 no_write(run('release-handoff-cleanup.mjs',{**state,**changed},['42','--apply'],False))
failed={'release':{**release,'created_at':ago(31)},'run':{**run_info,'conclusion':'failure','updated_at':ago(31)}}
no_write(run('release-handoff-cleanup.mjs',failed,['42','--abandon-reruns']))
calls=run('release-handoff-cleanup.mjs',failed,['42','--abandon-reruns','--apply']);assert sum('DELETE' in c for c in calls)==1
print('PASS: immutable Release publication, optional npm replay, and gated dry-run/manual cleanup')
