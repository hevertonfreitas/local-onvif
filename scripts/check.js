'use strict';

const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(name);
    return entry.name.endsWith('.js') ? [name] : [];
  });
}

const files = ['src', 'scripts'].flatMap(dir => sourceFiles(dir));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Sintaxe verificada em', files.length, 'arquivos JavaScript.');
