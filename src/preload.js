'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = channel => async data => {
  const reply = await ipcRenderer.invoke(channel, data);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
};

contextBridge.exposeInMainWorld('onvif', {
  list: call('camera:list'),
  discover: call('camera:discover'),
  save: call('camera:save'),
  remove: call('camera:remove'),
  connect: call('camera:connect'),
  startVideo: call('video:start'),
  pollVideo: call('video:poll'),
  stopVideo: call('video:stop'),
  copyUri: call('media:copy-uri'),
  capture: call('media:capture'),
  move: call('ptz:move'),
  stop: call('ptz:stop'),
  presets: call('ptz:presets'),
  gotoPreset: call('ptz:goto'),
});
