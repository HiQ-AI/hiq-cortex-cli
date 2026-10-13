import os,tempfile,pathlib,subprocess,json,shutil
root=pathlib.Path(tempfile.mkdtemp()); bindir=root/'bin';bindir.mkdir();db=root/'db';db.mkdir()
mock='''#!/usr/bin/env python3
import os,sys,json,pathlib,shutil
p=pathlib.Path(os.environ['MOCK_DB']); a=sys.argv[1:]
if a[:2]==['release','upload']:
 assets=[]
 for i,f in enumerate(a[5:],1):
  shutil.copyfile(f,p/str(i));assets.append({'name':pathlib.Path(f).name,'id':i})
 (p/'assets').write_text(json.dumps(assets))
elif '-X' in a:
 fields=dict(x.split('=',1) for x in a if '=' in x)
 r={'id':42,'draft':True,'tag_name':fields['tag_name'],'body':fields['body']}
 (p/'release').write_text(json.dumps(r));print(json.dumps(r))
elif '/assets/' in a[1]:sys.stdout.buffer.write((p/a[1].split('/')[-1]).read_bytes())
elif '/assets?' in a[1]:print((p/'assets').read_text())
else:print((p/'release').read_text())
'''
(bindir/'gh').write_text(mock);(bindir/'gh').chmod(0o755)
env={**os.environ,'PATH':str(bindir)+':'+os.environ['PATH'],'MOCK_DB':str(db),'GITHUB_REPOSITORY':'HiQ-AI/test','GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_OS':'macOS','RUNNER_ARCH':'ARM64','RUNNER_TEMP':str(root),'GITHUB_OUTPUT':str(root/'outputs')}
source=root/'source';source.mkdir();(source/'cli-darwin-arm64').write_text('example binary');(source/'checksums.txt').write_text('example checksum')
script=str(pathlib.Path(__file__).with_name('release-handoff.mjs').resolve())
def run(mode,expect=0,extra={}):
 result=subprocess.run(['node',script,mode,'binaries',str(source if mode=='upload' else root/'download')],env={**env,**extra},capture_output=True,text=True)
 assert (result.returncode==0)==(expect==0),result.stderr
run('upload');outputs=dict(l.split('=',1) for l in (root/'outputs').read_text().splitlines());env.update(TRANSFER_ID=outputs['release_id'],TRANSFER_ATTEMPT=outputs['attempt'],TRANSFER_MANIFEST_SHA256=outputs['manifest_sha256'])
run('download',extra={'GITHUB_RUN_ATTEMPT':'2'});assert (root/'download/cli-darwin-arm64').read_text()=='example binary'
run('download',1,{'GITHUB_RUN_ID':'124'});run('download',1,{'GITHUB_SHA':'b'*40});run('download',1,{'TRANSFER_ATTEMPT':'2'});run('download',1,{'TRANSFER_MANIFEST_SHA256':'0'*64})
r=json.loads((db/'release').read_text());r['draft']=False;(db/'release').write_text(json.dumps(r));run('download',1);r['draft']=True;(db/'release').write_text(json.dumps(r))
(db/'1').write_text('tampered');run('download',1)
print('PASS: round-trip, failed-job rerun, wrong run/SHA/attempt/manifest, published draft, tampered file (8 cases)')
