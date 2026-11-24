'use strict';

const { createHash } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { Arch } = require('electron-builder');

module.exports = async function checkBundledFfmpeg(context) {
  const project = context.packager.projectDir;
  const platform = context.electronPlatformName;
  const architecture = Arch[context.arch];
  const target = platform + '-' + architecture;
  const folder = join(project, '.build', 'ffmpeg');
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const script = await readFile(join(project, 'scripts', 'build-ffmpeg.sh'));
  const revision = createHash('sha256').update(script).digest('hex');
  const expected = target + ' ' + revision;
  const actual = await readFile(join(folder, 'build-target.txt'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const executable = await stat(join(folder, binary)).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (actual.trim() !== expected || !executable?.isFile()) {
    throw new Error('FFmpeg ausente ou desatualizado para ' + target +
      '. Execute bash scripts/build-ffmpeg.sh no sistema e arquitetura de destino.');
  }
};
