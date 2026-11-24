'use strict';

const { connect, describeError } = require('../src/onvif/client');
const { discover } = require('../src/onvif/discovery');
const { openVideo, waitForFrame } = require('../src/onvif/video');

async function credentials() {
  if (process.env.ONVIF_PASSWORD !== undefined) {
    return { username: process.argv[3] ?? process.env.ONVIF_USERNAME ?? '', password: process.env.ONVIF_PASSWORD };
  }
  if (!process.stdin.isTTY) throw new Error('Defina ONVIF_PASSWORD ou execute em um terminal interativo.');
  const readline = require('node:readline/promises');
  const { Writable } = require('node:stream');
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (muted) callback();
      else process.stdout.write(chunk, encoding, callback);
    },
  });
  output.isTTY = true;
  const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    const username = process.argv[3] ?? await terminal.question('Usuário ONVIF: ');
    process.stdout.write('Senha ONVIF: ');
    muted = true;
    const password = await terminal.question('');
    process.stdout.write('\n');
    return { username, password };
  } finally { terminal.close(); }
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.log('Câmeras encontradas:', await discover());
    return;
  }
  const { client, details } = await connect(address, await credentials());
  console.log('Dispositivo:', details.info.manufacturer, details.info.model);
  console.log('Serviço:', details.endpoint, '|', details.services.join(', '));
  for (const profile of details.profiles) {
    console.log('\nPerfil:', profile.name, '|', profile.encoding, '|', profile.width + '×' + profile.height, '| PTZ:', profile.ptz ? 'sim' : 'não');
    const [uri, snapshot, presets] = await Promise.allSettled([
      client.mediaUri(profile.token, 'GetStreamUri'),
      client.snapshot(profile.token),
      profile.ptz && details.services.includes('PTZ') ? client.presets(profile.token) : undefined,
    ]);
    console.log('  RTSP:', uri.status === 'fulfilled' ? uri.value.href : describeError(uri.reason));
    console.log('  Captura:', snapshot.status === 'fulfilled'
      ? snapshot.value.mime + ', ' + snapshot.value.bytes.length + ' bytes' : describeError(snapshot.reason));
    if (presets.status === 'rejected') console.log('  Posições PTZ:', describeError(presets.reason));
    else if (presets.value) console.log('  Posições PTZ:', presets.value.length);
  }
  if (process.argv.includes('--video')) {
    const profile = details.profiles.find(profile => profile.encoding === 'H264') ?? details.profiles[0];
    if (!profile) throw new Error('A câmera não apresentou perfis de vídeo.');
    const video = await openVideo(client, profile.token);
    try {
      const frame = await waitForFrame(video);
      console.log('\nVídeo ao vivo:', profile.name, '| quadro JPEG de', frame.length, 'bytes');
    } finally { video.stop(); }
  }
}

main().catch(error => {
  console.error(describeError(error));
  process.exitCode = 1;
});
