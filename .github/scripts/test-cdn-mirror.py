"""Test direct CDN publication with synthetic transport bytes and fake aws/curl commands.
The native/main guards are spied here; real binary checks run in the build gate.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
version = json.loads((repo / 'package.json').read_text())['version']
with tempfile.TemporaryDirectory(prefix='querying-lca-datasets-cdn-test-') as temporary:
    root = Path(temporary)
    bindir = root / 'bin'
    bindir.mkdir()
    fixtures = root / 'fixtures'
    fixtures.mkdir()
    names = [f'querying-lca-datasets-{platform}.tar.gz' for platform in [
        'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64',
    ]]
    for name in names:
        (fixtures / name).write_bytes(f'transport fixture: {name}'.encode())
    (fixtures / 'checksums.txt').write_text(''.join(
        f'{hashlib.sha256((fixtures / name).read_bytes()).hexdigest()}  ./{name}\n' for name in names))
    mock = '''#!/usr/bin/env python3
import base64,json,os,pathlib,sys
root=pathlib.Path(os.environ['MOCK_ROOT']); args=sys.argv[1:]; tool=pathlib.Path(sys.argv[0]).name
state=json.loads((root/'state.json').read_text())
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps([tool,*args])+'\\n')
def save(): (root/'state.json').write_text(json.dumps(state))
if tool=='node':
 if args and (args[0].endswith('verify-release.mjs') or args[0].endswith('check-native.mjs')):sys.exit(0)
 os.execv(os.environ['REAL_NODE'],[os.environ['REAL_NODE'],*args])
if tool=='gh':raise AssertionError('CDN publication must not use GitHub release transport')
objects=state.setdefault('objects',{})
if tool=='curl':
 key=args[args.index('-o')-1].split('https://download.hiq.earth/')[1]
 body=b'corrupt readback' if state.get('corrupt_readback') else base64.b64decode(objects[key])
 pathlib.Path(args[args.index('-o')+1]).write_bytes(body);sys.exit(0)
assert args[0]=='s3api'
operation=args[1];key=args[args.index('--key')+1]
assert key.startswith('cli/querying-lca-datasets/releases/v'),key
if operation=='head-object':
 if state.get('deny'):print('An error occurred (403)',file=sys.stderr);sys.exit(1)
 if key not in objects:print('An error occurred (404)',file=sys.stderr);sys.exit(1)
 print('{}')
elif operation=='get-object':pathlib.Path(args[-1]).write_bytes(base64.b64decode(objects[key]));print('{}')
elif operation=='put-object':
 assert args[args.index('--if-none-match')+1]=='*'
 if key in objects:print('An error occurred (412)',file=sys.stderr);sys.exit(1)
 objects[key]=base64.b64encode(pathlib.Path(args[args.index('--body')+1]).read_bytes()).decode();save();print('{}')
else:raise AssertionError(operation)
'''
    for name in ['gh', 'aws', 'curl', 'node']:
        command = bindir / name
        command.write_text(mock)
        command.chmod(0o755)
    env = {'PATH': f'{bindir}:{os.environ["PATH"]}', 'HOME': str(root), 'MOCK_ROOT': str(root),
           'REAL_NODE': shutil.which('node'), 'GITHUB_REF_NAME': 'main', 'GITHUB_SHA': 'a' * 40}

    def run(state, success=True):
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'calls.jsonl').write_text('')
        result = subprocess.run(['bash', str(repo / 'scripts/publish-cdn.sh'), str(fixtures)],
                                env=env, cwd=repo, capture_output=True, text=True)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
        assert not any(call[0] == 'gh' for call in calls)
        return json.loads((root / 'state.json').read_text()), calls

    state, calls = run({'objects': {}})
    prefix = f'cli/querying-lca-datasets/releases/v{version}/'
    assert len(state['objects']) == 8 and all(key.startswith(prefix) for key in state['objects'])
    assert sum(call[1:3] == ['s3api', 'put-object'] for call in calls) == 8
    assert sum(call[0] == 'curl' for call in calls) == 8
    first_aws = next(index for index, call in enumerate(calls) if call[0] == 'aws')
    assert any(call[:2] == ['node', '.github/scripts/verify-release.mjs'] for call in calls[:first_aws])
    assert any(call[:2] == ['node', 'scripts/check-native.mjs'] for call in calls[:first_aws])
    replay, calls = run(state)
    assert replay == state and not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    conflicted = json.loads(json.dumps(state))
    conflicted['objects'][prefix + names[0]] = base64.b64encode(b'different existing bytes').decode()
    after, calls = run(conflicted, False)
    assert after == conflicted and not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    after, calls = run({'objects': {}, 'deny': True}, False)
    assert not after['objects'] and not any(call[1:3] == ['s3api', 'put-object'] for call in calls)
    after, calls = run({'objects': {}, 'corrupt_readback': True}, False)
    assert len(after['objects']) == 1
    (fixtures / names[0]).write_bytes(b'tampered candidate')
    after, calls = run({'objects': {}}, False)
    assert not after['objects'] and not any(call[0] == 'aws' for call in calls)
print('PASS: CDN-only create/replay, conflict, denied access, checksum and readback gates')
