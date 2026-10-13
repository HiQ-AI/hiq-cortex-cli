import os,tempfile,pathlib,subprocess,json,shutil,hashlib
for workflow in pathlib.Path(__file__).resolve().parents[1].joinpath('workflows').glob('*.y*ml'):
 assert not any(action in workflow.read_text() for action in ('actions/upload-artifact@', 'actions/download-artifact@')), f'Actions artifact storage reintroduced: {workflow}'
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
source=root/'source';source.mkdir()
script=str(pathlib.Path(__file__).with_name('release-handoff.mjs').resolve())
contract=pathlib.Path(__file__).with_name('release-contract.mjs').resolve().as_uri()
files=json.loads(subprocess.check_output(['node','--input-type=module','-e',f"import {{expectedFiles}} from '{contract}'; console.log(JSON.stringify(expectedFiles('binaries')))"] ,text=True))
for name in files: (source/name).write_text('example-'+name)
def run(mode,expect=0,extra={}):
 result=subprocess.run(['node',script,mode,'binaries',str(source if mode=='upload' else root/'download')],env={**env,**extra},capture_output=True,text=True)
 assert (result.returncode==0)==(expect==0),result.stderr
run('upload');outputs=dict(l.split('=',1) for l in (root/'outputs').read_text().splitlines());env.update(TRANSFER_ID=outputs['release_id'],TRANSFER_ATTEMPT=outputs['attempt'],TRANSFER_MANIFEST_SHA256=outputs['manifest_sha256'])
run('download',extra={'GITHUB_RUN_ATTEMPT':'2'});assert all((root/'download'/name).read_bytes()==(source/name).read_bytes() for name in files)
run('download',1,{'GITHUB_RUN_ID':'124'});run('download',1,{'GITHUB_SHA':'b'*40});run('download',1,{'TRANSFER_ATTEMPT':'2'});run('download',1,{'TRANSFER_MANIFEST_SHA256':'0'*64})
r=json.loads((db/'release').read_text());r['draft']=False;(db/'release').write_text(json.dumps(r));run('download',1);r['draft']=True;(db/'release').write_text(json.dumps(r))
original=(db/'1').read_bytes();(db/'1').write_text('tampered');run('download',1);(db/'1').write_bytes(original)
assets=json.loads((db/'assets').read_text())
manifest_file=db/str(next(a['id'] for a in assets if a['name']=='binaries-manifest.json'))
original=manifest_file.read_bytes()
# Recompute the trusted output hash: reject producer claims, not just hash tampering.
for mutation in ['missing', 'extra', 'platform', 'producer']:
 m=json.loads(original)
 if mutation=='missing': m['files'].pop()
 elif mutation=='extra': m['files'].append({**m['files'][0],'name':'unexpected.bin'})
 elif mutation=='platform': m['files'][0]['platform']='wrong-platform'
 else: m['producerPlatform']='Linux-X64'
 content=json.dumps(m).encode();manifest_file.write_bytes(content)
 run('download',1,{'TRANSFER_MANIFEST_SHA256':hashlib.sha256(content).hexdigest()})
manifest_file.write_bytes(original)
(db/'assets').write_text(json.dumps(assets+[{'id':999,'name':'stray.asset'}]));run('download',1)
(db/'assets').write_text(json.dumps(assets))
(source/'unexpected.bin').write_text('extra');run('upload',1);(source/'unexpected.bin').unlink()
name=next(iter(files));(source/name).unlink();(source/name).symlink_to(source/next(n for n in files if n!=name));run('upload',1)
print('PASS: handoff identity, rerun, digests, exact file/platform/producer contracts, extra assets and symlinks (15 cases)')
