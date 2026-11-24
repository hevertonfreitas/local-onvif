'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } = require('electron');
const { join } = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Cameras } = require('./cameras');
const { connect, describeError, OnvifError } = require('./onvif/client');
const { discover } = require('./onvif/discovery');
const { openVideo, waitForFrame } = require('./onvif/video');

const page = join(__dirname, 'renderer', 'index.html');
const pageUrl = pathToFileURL(page).href;
const icon = join(__dirname, '..', 'assets', 'icon.png');
const sessions = new Map();
const captureVideos = new Set();
let cameras;
let window;
let videoRequest;
let activeVideo;

function clientFor(id) {
  const session = sessions.get(id);
  if (!session?.client) throw new OnvifError('Conecte a câmera primeiro.');
  return session.client;
}

function stopVideo() {
  videoRequest = undefined;
  activeVideo?.video.stop();
  activeVideo = undefined;
}

function stopAllVideo() {
  stopVideo();
  for (const video of captureVideos) video.stop();
  captureVideos.clear();
}

function invalidate(id) {
  sessions.delete(id);
  if (videoRequest?.id === id || activeVideo?.id === id) stopVideo();
}

function register(name, handler) {
  ipcMain.handle(name, async (event, data = {}) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pageUrl || event.senderFrame?.parent) {
      return { ok: false, error: 'Origem da solicitação inválida.' };
    }
    try { return { ok: true, data: await handler(data) }; } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
}

register('camera:list', () => cameras.list());
register('camera:discover', () => discover());
register('camera:save', input => {
  const camera = cameras.save(input);
  invalidate(camera.id);
  return camera;
});
register('camera:remove', ({ id }) => {
  cameras.remove(id);
  invalidate(id);
});
register('camera:connect', async ({ id }) => {
  const camera = cameras.get(id);
  const credentials = { username: camera.username, password: cameras.password(id) };
  invalidate(id);
  const session = {};
  sessions.set(id, session);
  try {
    const { client, details } = await connect(camera.address, credentials);
    if (sessions.get(id) !== session) return;
    session.client = client;
    return details;
  } catch (error) {
    if (sessions.get(id) === session) sessions.delete(id);
    throw error;
  }
});
register('video:start', async ({ id, token, key }) => {
  const client = clientFor(id);
  stopVideo();
  const request = { id, key };
  videoRequest = request;
  const video = await openVideo(client, token);
  if (videoRequest !== request) {
    video.stop();
    return;
  }
  activeVideo = { id, token, key, video };
});
register('video:poll', ({ key, sequence }) => {
  if (activeVideo?.key !== key) return { status: 'stopped' };
  return activeVideo.video.poll(sequence);
});
register('video:stop', ({ key }) => {
  if (videoRequest?.key === key || activeVideo?.key === key) stopVideo();
});
register('media:copy-uri', async ({ id, token }) => {
  const uri = await clientFor(id).mediaUri(token, 'GetStreamUri');
  clipboard.writeText(uri.href);
});
register('media:capture', async ({ id, token }) => {
  const client = clientFor(id);
  let image;
  try {
    image = await client.snapshot(token);
  } catch {
    const existing = activeVideo?.id === id && activeVideo.token === token
      && ['live', 'starting'].includes(activeVideo.video.status) ? activeVideo.video : undefined;
    const video = existing ?? await openVideo(client, token);
    if (!existing) captureVideos.add(video);
    try { image = { bytes: await waitForFrame(video), mime: 'image/jpeg' }; } finally {
      if (!existing) {
        video.stop();
        captureVideos.delete(video);
      }
    }
  }
  if (!window || window.isDestroyed()) return false;
  const png = image.mime === 'image/png';
  const name = cameras.get(id).name.replace(/[^\p{L}\p{N} _-]+/gu, '-').slice(0, 60);
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(window, {
    title: 'Salvar captura',
    defaultPath: join(app.getPath('pictures'), name + '-' + date + (png ? '.png' : '.jpg')),
    filters: [{ name: png ? 'Imagem PNG' : 'Imagem JPEG', extensions: [png ? 'png' : 'jpg', ...(png ? [] : ['jpeg'])] }],
  });
  if (result.canceled || !result.filePath) return false;
  try { await writeFile(result.filePath, image.bytes); } catch {
    throw new OnvifError('Não foi possível salvar a imagem no local escolhido.');
  }
  return true;
});
register('ptz:move', ({ id, token, x, y, zoom }) => clientFor(id).move(token, x, y, zoom));
register('ptz:stop', ({ id, token }) => clientFor(id).stop(token));
register('ptz:presets', ({ id, token }) => clientFor(id).presets(token));
register('ptz:goto', ({ id, token, preset }) => clientFor(id).gotoPreset(token, preset));

function createWindow() {
  window = new BrowserWindow({
    width: 1340, height: 900, minWidth: 760, minHeight: 640,
    backgroundColor: '#141719',
    title: 'ONVIF Local',
    icon,
    webPreferences: {
      preload: join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', stopAllVideo);
  window.on('closed', () => {
    stopAllVideo();
    sessions.clear();
    window = undefined;
  });
  window.loadFile(page);
}

app.setName('ONVIF Local');
app.whenReady().then(() => {
  app.dock?.setIcon(icon);
  app.setAppUserModelId('br.local.onvif');
  try {
    cameras = new Cameras(join(app.getPath('userData'), 'cameras.json'), safeStorage);
  } catch (error) {
    dialog.showErrorBox('ONVIF Local', error.message);
    app.quit();
    return;
  }
  app.on('activate', () => { if (!window) createWindow(); });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopAllVideo);
