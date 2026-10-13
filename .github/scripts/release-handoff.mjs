// Temporary draft Releases remain private and are retained for failed-job reruns.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const e=process.env, [mode,kind,dir]=process.argv.slice(2);
assert(['npm-package','binaries'].includes(kind));
const repo=e.GITHUB_REPOSITORY, base=`repos/${repo}/releases`;
const gh=(...args)=>execFileSync('gh',args,{maxBuffer:512*1024*1024});
const api=(...args)=>JSON.parse(gh('api',...args));
const hash=b=>createHash('sha256').update(b).digest('hex');
const context={repository:repo,sha:e.GITHUB_SHA,run:e.GITHUB_RUN_ID,kind};
const attempt=mode==='upload'?e.GITHUB_RUN_ATTEMPT:e.TRANSFER_ATTEMPT;
assert.match(attempt||'',/^\d+$/);
const identity={...context,attempt}, tag=`ci-transfer-${context.run}-${attempt}-${kind}`;
const validName=name=>{assert.match(name,/^[a-zA-Z0-9_.-]+$/); assert(!['.','..'].includes(name));};
if(mode==='upload'){
  const files=fs.readdirSync(dir).filter(n=>kind!=='npm-package'||n.endsWith('.tgz')).sort().map(name=>{
    validName(name); const p=path.join(dir,name); assert(fs.lstatSync(p).isFile());
    const b=fs.readFileSync(p);
    return {name,bytes:b.length,sha256:hash(b),platform:name.match(/(?:darwin|linux|windows)-(?:arm64|x64)/)?.[0]||'portable'};
  });
  assert(files.length>0);
  const manifest=JSON.stringify({...identity,producerPlatform:`${e.RUNNER_OS}-${e.RUNNER_ARCH}`,files});
  const p=path.join(e.RUNNER_TEMP,`${kind}-manifest.json`); fs.writeFileSync(p,manifest);
  // No --clobber, no publication, and no real tag creation.
  const release=api(base,'-X','POST','-f',`tag_name=${tag}`,'-f',`target_commitish=${e.GITHUB_SHA}`,'-f',`name=${tag}`,'-f',`body=${JSON.stringify(identity)}`,'-F','draft=true');
  assert.equal(release.draft,true);
  gh('release','upload',tag,'--repo',repo,...files.map(f=>path.join(dir,f.name)),p);
  fs.appendFileSync(e.GITHUB_OUTPUT,`release_id=${release.id}\nattempt=${attempt}\nmanifest_sha256=${hash(manifest)}\n`);
  console.log(manifest);
}else if(mode==='download'){
  assert.match(e.TRANSFER_ID||'',/^\d+$/);
  const release=api(`${base}/${e.TRANSFER_ID}`);
  assert.equal(release.draft,true,'Candidate is no longer private');
  assert.equal(release.tag_name,tag); assert.deepEqual(JSON.parse(release.body),identity);
  const assets=api(`${base}/${e.TRANSFER_ID}/assets?per_page=100`);
  const download=name=>{
    const matches=assets.filter(a=>a.name===name); assert.equal(matches.length,1);
    return gh('api',`${base}/assets/${matches[0].id}`,'-H','Accept: application/octet-stream');
  };
  const b=download(`${kind}-manifest.json`); assert.equal(hash(b),e.TRANSFER_MANIFEST_SHA256);
  const manifest=JSON.parse(b);
  for(const [k,v] of Object.entries(identity)) assert.equal(manifest[k],v);
  assert(manifest.files.length>0); assert.equal(new Set(manifest.files.map(f=>f.name)).size,manifest.files.length);
  const tmp=fs.mkdtempSync(path.join(e.RUNNER_TEMP,`handoff-${kind}-`));
  for(const f of manifest.files){
    validName(f.name); const b=download(f.name);
    assert.equal(b.length,f.bytes); assert.equal(hash(b),f.sha256);
    fs.writeFileSync(path.join(tmp,f.name),b);
  }
  // Publishing sees files only after all digests pass.
  fs.mkdirSync(dir,{recursive:true});
  for(const f of manifest.files) fs.copyFileSync(path.join(tmp,f.name),path.join(dir,f.name));
  console.log(JSON.stringify(manifest));
}else throw Error('Expected upload or download');
