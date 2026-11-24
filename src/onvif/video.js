'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { OnvifError } = require('./client');

const jpegStart = Buffer.from([0xff, 0xd8]);
const jpegEnd = Buffer.from([0xff, 0xd9]);
const maxFrameBytes = 5 * 1024 * 1024;

function ffmpegExecutable() {
  if (process.env.ONVIF_FFMPEG) return process.env.ONVIF_FFMPEG;
  try {
    const executable = require('ffmpeg-static');
    if (executable && existsSync(executable)) return executable;
  } catch {
    // The system binary can be used when the optional dependency is unavailable.
  }
  return 'ffmpeg';
}

function ffmpegError(stderr) {
  if (/401|403|Unauthorized/.test(stderr)) return 'O servidor RTSP recusou a autenticação.';
  if (/Connection refused/i.test(stderr)) return 'A câmera recusou a conexão de vídeo RTSP.';
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'A rota da rede para o servidor RTSP está indisponível.';
  if (/timed out|Timeout/i.test(stderr)) return 'O servidor RTSP demorou para responder.';
  return 'A transmissão RTSP foi encerrada pela câmera ou pelo decodificador.';
}

class Video {
  constructor(uri, credentials) {
    const source = new URL(uri);
    if (credentials.username) {
      // URL setters preserve an existing percent sign unless it is encoded explicitly.
      source.username = encodeURIComponent(credentials.username);
      source.password = encodeURIComponent(credentials.password);
    }
    this.status = 'starting';
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.lastFrameAt = Date.now();
    this.child = spawn(ffmpegExecutable(), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'rtsp,rtsps,rtp,tcp,tls,udp',
      '-rtsp_transport', 'tcp', '-allowed_media_types', 'video', '-timeout', '6000000',
      '-analyzeduration', '1200000', '-probesize', '2000000', '-i', source.href,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', "fps=8,scale=w='min(1280,iw)':h=-2",
      '-threads', '2', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-1000); });
    this.child.on('error', error => this.fail(error.code === 'ENOENT'
      ? 'FFmpeg indisponível. Instale-o ou configure ONVIF_FFMPEG.'
      : 'Não foi possível iniciar o decodificador de vídeo.'));
    this.child.on('close', () => {
      if (this.status === 'starting' || this.status === 'live') this.fail(ffmpegError(this.stderr));
      this.stderr = '';
    });
    this.watchdog = setInterval(() => {
      const limit = this.status === 'live' ? 9000 : 18000;
      if (Date.now() - this.lastFrameAt > limit) this.fail('A câmera não enviou quadros de vídeo dentro do prazo.');
    }, 1000);
    this.watchdog.unref();
  }

  consume(chunk) {
    if (this.status !== 'starting' && this.status !== 'live') return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const first = this.buffer.indexOf(jpegStart);
      if (first === -1) {
        this.buffer = this.buffer.subarray(-1);
        return;
      }
      const last = this.buffer.indexOf(jpegEnd, first + jpegStart.length);
      if (last === -1) {
        this.buffer = this.buffer.length > maxFrameBytes ? Buffer.alloc(0) : this.buffer.subarray(first);
        return;
      }
      this.frame = this.buffer.subarray(first, last + jpegEnd.length);
      this.buffer = this.buffer.subarray(last + jpegEnd.length);
      this.sequence += 1;
      this.status = 'live';
      this.lastFrameAt = Date.now();
    }
  }

  poll(sequence) {
    return {
      status: this.status,
      error: this.error,
      sequence: this.sequence,
      data: this.frame && sequence !== this.sequence ? 'data:image/jpeg;base64,' + this.frame.toString('base64') : '',
    };
  }

  fail(message) {
    if (this.status === 'stopped' || this.status === 'error') return;
    this.error = message;
    this.stop('error');
  }

  stop(status = 'stopped') {
    this.status = status;
    clearInterval(this.watchdog);
    this.buffer = Buffer.alloc(0);
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
      this.child.kill('SIGKILL');
    }
  }
}

async function openVideo(client, token) {
  const uri = await client.mediaUri(token, 'GetStreamUri');
  return new Video(uri, client.credentials);
}

async function waitForFrame(video, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!video.frame && ['starting', 'live'].includes(video.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!video.frame) throw new OnvifError(video.error || 'Nenhum quadro RTSP recebido no prazo.');
  return video.frame;
}

module.exports = { openVideo, waitForFrame };
