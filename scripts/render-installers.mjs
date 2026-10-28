import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(Object.keys(pkg.bin), ['querying-lca-datasets']);
const base = `https://download.hiq.earth/cli/querying-lca-datasets/releases/v${pkg.version}`;
const output = resolve(process.argv[2]);
mkdirSync(output, {recursive: true});
for (const extension of ['sh', 'ps1']) {
  const template = readFileSync(new URL(`install.${extension}`, import.meta.url), 'utf8');
  const replacements = extension === 'sh'
    ? [['DEFAULT_VERSION=""', `DEFAULT_VERSION="${pkg.version}"`], ['DEFAULT_BASE=""', `DEFAULT_BASE="${base}"`]]
    : [["$DefaultVersion = ''", `$DefaultVersion = '${pkg.version}'`], ["$DefaultBase = ''", `$DefaultBase = '${base}'`]];
  let content = template;
  for (const [before, after] of replacements) {
    assert.equal(content.split(before).length, 2, `Expected one ${before} marker`);
    content = content.replace(before, after);
  }
  writeFileSync(join(output, `install.${extension}`), content);
}
console.log(base);
