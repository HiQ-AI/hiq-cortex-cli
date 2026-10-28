"""Exercise conditional CDN creation with fake gh/aws commands; no network or credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='lca-background-data-cdn-test-') as temporary:
    root = Path(temporary)
    bindir = root / 'bin'
    bindir.mkdir()
    fixtures = root / 'fixtures'
    fixtures.mkdir()
    names = [f'lca-background-data-{platform}.{extension}' for platform, extension in [
        ('darwin-arm64', 'tar.gz'), ('darwin-x64', 'tar.gz'), ('linux-arm64', 'tar.gz'),
        ('linux-x64', 'tar.gz'), ('windows-x64', 'zip'),
    ]]
    for name in names:
        (fixtures / name).write_bytes(f'transport fixture: {name}'.encode())
    (fixtures / 'checksums.txt').write_text(''.join(
        f'{hashlib.sha256((fixtures / name).read_bytes()).hexdigest()}  ./{name}\n' for name in names))
    mock = '''#!/usr/bin/env python3
import base64,json,os,pathlib,shutil,sys
root=pathlib.Path(os.environ['MOCK_ROOT']); args=sys.argv[1:]
state=json.loads((root/'state.json').read_text())
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps([pathlib.Path(sys.argv[0]).name,*args])+'\\n')
def save(): (root/'state.json').write_text(json.dumps(state))
if pathlib.Path(sys.argv[0]).name=='gh':
 destination=pathlib.Path(args[args.index('--dir')+1])
 for source in (root/'fixtures').iterdir(): shutil.copyfile(source,destination/source.name)
 sys.exit(0)
if args[0]=='cloudfront': print('fixture-invalidation');sys.exit(0)
operation=args[1];key=args[args.index('--key')+1]
assert key.startswith('cli/lca-background-data/'),key
objects=state.setdefault('objects',{})
if operation=='head-object':
 if state.get('deny'): print('An error occurred (403)',file=sys.stderr);sys.exit(1)
 if key not in objects: print('An error occurred (404)',file=sys.stderr);sys.exit(1)
 print('{}')
elif operation=='get-object': pathlib.Path(args[-1]).write_bytes(base64.b64decode(objects[key]));print('{}')
elif operation=='put-object':
 assert args[args.index('--if-none-match')+1]=='*'
 if key in objects: print('An error occurred (412)',file=sys.stderr);sys.exit(1)
 objects[key]=base64.b64encode(pathlib.Path(args[args.index('--body')+1]).read_bytes()).decode();save();print('{}')
else: raise AssertionError(operation)
'''
    for name in ['gh', 'aws']:
        command = bindir / name
        command.write_text(mock)
        command.chmod(0o755)
    env = {'PATH': f'{bindir}:{os.environ["PATH"]}', 'HOME': str(root), 'MOCK_ROOT': str(root)}

    def run(state, success=True):
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'calls.jsonl').write_text('')
        result = subprocess.run(['bash', str(repo / 'scripts/mirror-to-cdn.sh'), 'v0.5.0'],
                                env=env, cwd=repo, capture_output=True, text=True)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
        return json.loads((root / 'state.json').read_text()), calls

    state, calls = run({'objects': {}})
    assert len(state['objects']) == 14
    assert sum(call[1:3] == ['s3api', 'put-object'] for call in calls) == 14
    replay, calls = run(state)
    assert replay == state
    assert not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    conflicted = json.loads(json.dumps(state))
    key = 'cli/lca-background-data/releases/v0.5.0/lca-background-data-darwin-arm64.tar.gz'
    conflicted['objects'][key] = base64.b64encode(b'different existing bytes').decode()
    after, calls = run(conflicted, False)
    assert after == conflicted
    assert not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    after, calls = run({'objects': {}, 'deny': True}, False)
    assert not after['objects']
    assert not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    (fixtures / names[0]).write_bytes(b'tampered download')
    after, calls = run({'objects': {}}, False)
    assert not after['objects']
    assert not any(call[0] == 'aws' for call in calls)
print('PASS: conditional CDN creation, identical replay, conflicts, denied access and checksum failure')
