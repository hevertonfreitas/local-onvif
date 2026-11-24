'use strict';

const api = window.onvif;
const byId = id => document.getElementById(id);
const state = {
  cameras: [],
  selected: '',
  connections: new Map(),
  profile: null,
  video: { status: 'idle' },
  presets: [],
  presetState: 'idle',
};
const frame = byId('frame');
const viewport = byId('viewport');
let motion;
let ptzQueue = Promise.resolve();
let notificationTimer;
let editing;
let searching = false;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function showNotice(message, type = 'success') {
  const notice = byId('notice');
  clearTimeout(notificationTimer);
  notice.textContent = message;
  notice.dataset.state = type;
  notice.hidden = false;
  notificationTimer = setTimeout(() => { notice.hidden = true; }, type === 'error' ? 6500 : 3000);
}

function camera() { return state.cameras.find(camera => camera.id === state.selected); }
function connection() { return state.connections.get(state.selected) ?? { status: 'idle' }; }
function selection() { return { id: state.selected, token: state.profile?.token }; }
function matchesSelection({ id, token }) { return id === state.selected && token === state.profile?.token; }

function renderList() {
  byId('camera-count').textContent = state.cameras.length;
  byId('empty-list').hidden = Boolean(state.cameras.length);
  byId('camera-list').replaceChildren(...state.cameras.map(camera => {
    const row = el('button', 'camera-row');
    const icon = el('span', 'row-icon');
    icon.append(el('span', 'camera-icon'));
    icon.setAttribute('aria-hidden', 'true');
    row.setAttribute('aria-current', camera.id === state.selected ? 'true' : 'false');
    row.dataset.state = state.connections.get(camera.id)?.status ?? 'idle';
    const label = el('span');
    label.append(el('strong', '', camera.name), el('small', '', camera.address));
    row.append(icon, label, el('span', 'status-dot'));
    row.addEventListener('click', () => selectCamera(camera.id));
    return row;
  }));
}

const statusLabels = { idle: 'Desconectada', connecting: 'Conectando', online: 'Conectada', error: 'Falha na conexão' };

function renderHeader() {
  const active = camera();
  const { status, details } = connection();
  const connectionBadge = byId('connection');
  const retry = byId('connect');
  byId('current-address').hidden = !active;
  byId('current-address').textContent = active?.address ?? '';
  byId('camera-name').textContent = active?.name ?? 'Monitoramento';
  byId('intro').textContent = details
    ? [details.info.manufacturer, details.info.model].filter(Boolean).join(' · ')
    : active ? '' : 'Adicione uma câmera ou busque dispositivos na rede local.';
  byId('intro').hidden = !byId('intro').textContent;
  connectionBadge.hidden = !active;
  connectionBadge.dataset.state = status;
  byId('connection-label').textContent = statusLabels[status];
  byId('edit-camera').hidden = !active;
  retry.hidden = !active;
  retry.disabled = status === 'connecting';
  retry.textContent = status === 'online' ? 'Reconectar' : status === 'connecting' ? 'Conectando…' : 'Conectar';
}

function profileDescription(profile) {
  return [profile.encoding, profile.width && profile.height ? profile.width + ' × ' + profile.height : ''].filter(Boolean).join(' · ');
}

function renderProfiles() {
  const profiles = connection().details?.profiles ?? [];
  byId('profile-field').hidden = !profiles.length;
  const select = byId('profiles');
  select.replaceChildren(...profiles.map(profile => {
    const description = profileDescription(profile);
    return new Option(profile.name + (description ? ' · ' + description : ''), profile.token);
  }));
  if (state.profile) select.value = state.profile.token;
}

function renderDevice() {
  const { details } = connection();
  const list = byId('device-info');
  byId('device-empty').hidden = Boolean(details);
  list.hidden = !details;
  if (!details) { list.replaceChildren(); return; }
  const { info } = details;
  const fields = [
    ['Fabricante', info.manufacturer], ['Modelo', info.model], ['Firmware', info.firmwareVersion],
    ['Número de série', info.serialNumber], ['Hardware', info.hardwareId],
    ['Serviços ONVIF', details.services.join(' · ')], ['Endpoint ONVIF', details.endpoint, true],
  ];
  list.replaceChildren(...fields.map(([label, value, wide]) => {
    const item = el('div', wide ? 'wide' : '');
    item.append(el('dt', '', label), el('dd', '', value || '—'));
    return item;
  }));
}

function renderVideo() {
  const video = state.video;
  const { details, status, error } = connection();
  const live = video.status === 'live';
  const playing = live || video.status === 'starting';
  frame.hidden = !live;
  byId('live-overlay').hidden = !live;
  byId('view-status').hidden = live;
  byId('view-status').dataset.state = video.status === 'idle' ? status : video.status;
  byId('video-spec').textContent = state.profile ? profileDescription(state.profile) : '';
  byId('video-spec').hidden = !byId('video-spec').textContent;
  byId('toggle-video').disabled = !state.profile;
  byId('capture').disabled = !state.profile || Boolean(state.capturing);
  byId('capture-label').textContent = state.capturing ? 'Preparando captura…' : 'Salvar captura';
  byId('copy-uri').disabled = !state.profile;
  byId('fullscreen').disabled = !live;
  byId('play-label').textContent = playing ? 'Parar vídeo' : 'Iniciar vídeo';
  byId('play-icon').textContent = playing ? '■' : '▶';

  let title = 'Nenhuma câmera selecionada';
  let subtitle = 'Conecte uma câmera ONVIF para visualizar o vídeo.';
  if (video.status === 'error') {
    title = 'Vídeo indisponível';
    subtitle = video.error;
  } else if (video.status === 'starting') {
    title = 'Abrindo transmissão';
    subtitle = 'Aguardando os primeiros quadros RTSP.';
  } else if (state.profile) {
    title = 'Vídeo pausado';
    subtitle = 'Selecione Iniciar vídeo para retomar.';
  } else if (status === 'online') {
    title = 'Nenhum perfil de vídeo disponível';
    subtitle = details.profileError || 'A câmera não retornou perfis de mídia.';
  } else if (status === 'connecting') {
    title = 'Conectando à câmera';
    subtitle = 'Consultando o dispositivo e os perfis de mídia.';
  } else if (status === 'error') {
    title = 'Falha na conexão';
    subtitle = error;
  } else if (camera()) {
    title = 'Câmera desconectada';
    subtitle = 'Selecione Conectar para consultar o dispositivo.';
  }
  byId('view-title').textContent = title;
  byId('view-text').textContent = subtitle;
}

function hasPtz() {
  return Boolean(state.profile?.ptz && connection().details?.services.includes('PTZ'));
}

function renderPtz() {
  const available = hasPtz();
  byId('ptz-controls').disabled = !available;
  byId('ptz-indicator').dataset.state = available ? 'online' : 'idle';
  byId('ptz-hint').textContent = available
    ? 'Mantenha pressionado para mover.'
    : state.profile ? 'O perfil selecionado não oferece PTZ.' : 'Selecione um perfil com suporte a PTZ.';
  const presets = byId('presets');
  const old = presets.value;
  const { presetState, presets: items } = state;
  const placeholder = { loading: 'Consultando…', error: 'Indisponível' }[presetState] ?? 'Sem posições';
  presets.replaceChildren(...(items.length ? items.map(item => new Option(item.name, item.token)) : [new Option(placeholder, '')]));
  if (items.some(item => item.token === old)) presets.value = old;
  presets.disabled = !items.length;
  byId('goto-preset').disabled = !items.length;
}

function render() {
  renderList();
  renderHeader();
  renderProfiles();
  renderDevice();
  renderVideo();
  renderPtz();
}

function resetVideo() {
  const previous = state.video;
  clearTimeout(previous.timer);
  state.video = { status: 'idle' };
  if (previous.key) void api.stopVideo({ key: previous.key }).catch(() => {});
  frame.removeAttribute('src');
  if (document.fullscreenElement === viewport) void document.exitFullscreen().catch(() => {});
}

function videoFailed(video, error) {
  if (state.video !== video) return;
  video.status = 'error';
  video.error = error;
  renderVideo();
}

async function pollVideo(video) {
  if (state.video !== video) return;
  try {
    const next = await api.pollVideo({ key: video.key, sequence: video.sequence });
    if (state.video !== video) return;
    if (next.status === 'stopped' || next.status === 'error') {
      videoFailed(video, next.error || 'A transmissão foi interrompida.');
      return;
    }
    if (next.data) {
      frame.src = next.data;
      video.sequence = next.sequence;
      if (video.status !== 'live') {
        video.status = 'live';
        renderVideo();
      }
    }
    video.timer = setTimeout(() => void pollVideo(video), 120);
  } catch (error) { videoFailed(video, error.message); }
}

async function playVideo() {
  if (!state.profile) return;
  resetVideo();
  const video = { status: 'starting', key: crypto.randomUUID(), sequence: 0 };
  state.video = video;
  renderVideo();
  try {
    await api.startVideo({ ...selection(), key: video.key });
    await pollVideo(video);
  } catch (error) { videoFailed(video, error.message); }
}

async function loadPresets() {
  state.presets = [];
  state.presetState = hasPtz() ? 'loading' : 'idle';
  renderPtz();
  if (!hasPtz()) return;
  const selected = selection();
  const request = Symbol();
  state.presetsRequest = request;
  try {
    const items = await api.presets(selected);
    if (!matchesSelection(selected) || state.presetsRequest !== request) return;
    state.presets = items;
    state.presetState = 'ready';
  } catch {
    if (!matchesSelection(selected) || state.presetsRequest !== request) return;
    state.presetState = 'error';
  }
  renderPtz();
}

function activateProfile(profile, autoplay) {
  resetVideo();
  endMotion();
  state.profile = profile;
  state.presets = [];
  state.presetState = 'idle';
  state.presetsRequest = undefined;
  render();
  void loadPresets();
  if (autoplay && state.profile) void playVideo();
}

async function connectCamera(id) {
  if (!id || state.connections.get(id)?.status === 'connecting') return;
  const pending = { status: 'connecting' };
  state.connections.set(id, pending);
  if (id === state.selected) activateProfile(null, false);
  else renderList();
  try {
    const details = await api.connect({ id });
    if (!details || state.connections.get(id) !== pending) return;
    state.connections.set(id, { status: 'online', details });
    if (state.selected === id) activateProfile(details.profiles[0] ?? null, true);
    else renderList();
  } catch (error) {
    if (state.connections.get(id) !== pending) return;
    state.connections.set(id, { status: 'error', error: error.message });
    render();
  }
}

function selectCamera(id) {
  if (id === state.selected) return;
  state.selected = id;
  activateProfile(connection().details?.profiles[0] ?? null, true);
  if (connection().status === 'idle') void connectCamera(id);
}

function openCameraForm(camera, candidate) {
  editing = camera;
  const dialog = byId('camera-dialog');
  byId('form-title').textContent = camera ? 'Editar câmera' : 'Adicionar câmera';
  byId('label').value = camera?.name ?? candidate?.name ?? '';
  byId('address').value = camera?.address ?? candidate?.endpoint ?? '';
  byId('username').value = camera?.username ?? '';
  byId('password').value = '';
  byId('password').placeholder = camera?.hasPassword ? 'Senha salva' : '';
  byId('remember').checked = Boolean(camera?.hasPassword);
  byId('remove-camera').hidden = !camera;
  byId('form-error').hidden = true;
  if (!dialog.open) dialog.showModal();
  byId(candidate ? 'username' : 'label').focus();
}

async function saveCamera(event) {
  event.preventDefault();
  const submit = byId('submit-camera');
  if (submit.disabled) return;
  const dialog = byId('camera-dialog');
  const errorText = byId('form-error');
  submit.disabled = true;
  errorText.hidden = true;
  try {
    const record = await api.save({
      id: editing?.id,
      name: byId('label').value,
      address: byId('address').value,
      username: byId('username').value,
      password: byId('password').value,
      remember: byId('remember').checked,
    });
    byId('password').value = '';
    const index = state.cameras.findIndex(camera => camera.id === record.id);
    if (index === -1) state.cameras.push(record);
    else state.cameras[index] = record;
    state.connections.delete(record.id);
    if (dialog.open) dialog.close();
    state.selected = record.id;
    void connectCamera(record.id);
  } catch (error) {
    errorText.textContent = error.message;
    errorText.hidden = false;
  } finally { submit.disabled = false; }
}

async function removeCamera() {
  const id = editing?.id;
  if (!id) return;
  const button = byId('confirm-remove');
  button.disabled = true;
  try {
    if (state.selected === id) endMotion();
    await api.remove({ id });
    state.cameras = state.cameras.filter(camera => camera.id !== id);
    state.connections.delete(id);
    byId('remove-dialog').close();
    byId('camera-dialog').close();
    if (state.selected === id) {
      state.selected = '';
      activateProfile(null, false);
      if (state.cameras.length) selectCamera(state.cameras[0].id);
    } else render();
    showNotice('Câmera removida.');
  } catch (error) {
    byId('remove-dialog').close();
    byId('form-error').textContent = error.message;
    byId('form-error').hidden = false;
  } finally { button.disabled = false; }
}

async function search() {
  const dialog = byId('discovery-dialog');
  if (!dialog.open) dialog.showModal();
  if (searching) return;
  searching = true;
  const content = byId('discovery-content');
  const retry = byId('retry-discovery');
  content.replaceChildren(el('p', '', 'Buscando dispositivos ONVIF na rede local…'));
  retry.disabled = true;
  try {
    const devices = await api.discover();
    if (!devices.length) {
      content.replaceChildren(el('p', '', 'Nenhuma câmera respondeu. Você pode informar o endereço manualmente.'));
      return;
    }
    content.replaceChildren(...devices.map(device => {
      const button = el('button', 'discovery-result');
      const icon = el('span', 'row-icon');
      icon.append(el('span', 'camera-icon'));
      icon.setAttribute('aria-hidden', 'true');
      const description = el('span');
      description.append(el('strong', '', device.name), el('small', '', device.endpoint));
      button.append(icon, description);
      button.addEventListener('click', () => {
        dialog.close();
        const existing = state.cameras.find(camera => camera.address === device.endpoint || camera.address === device.host);
        if (existing) selectCamera(existing.id);
        else openCameraForm(null, device);
      });
      return button;
    }));
  } catch (error) {
    content.replaceChildren(el('p', '', error.message));
  } finally {
    searching = false;
    retry.disabled = false;
  }
}

function enqueuePtz(action) {
  const task = ptzQueue.then(action);
  ptzQueue = task.catch(() => {});
  return task;
}

function endMotion() {
  const current = motion;
  if (!current) return;
  motion = undefined;
  clearTimeout(current.timer);
  if (current.sent) {
    void enqueuePtz(async () => {
      const elapsed = Date.now() - current.sent;
      if (elapsed < 150) await new Promise(resolve => setTimeout(resolve, 150 - elapsed));
      await api.stop(current.selected);
    }).catch(error => { if (matchesSelection(current.selected)) showNotice(error.message, 'error'); });
  }
}

function startMotion(button, once) {
  if (!hasPtz()) return;
  endMotion();
  const [x, y, zoom] = button.dataset.vector.split(',').map(Number);
  const current = { selected: selection() };
  motion = current;
  async function tick() {
    try {
      await enqueuePtz(async () => {
        if (motion !== current) return;
        current.sent = Date.now();
        await api.move({ ...current.selected, x, y, zoom });
      });
      if (motion !== current) return;
      current.timer = setTimeout(once ? endMotion : tick, once ? 200 : 550);
    } catch (error) {
      if (motion !== current) return;
      motion = undefined;
      showNotice(error.message, 'error');
    }
  }
  void tick();
}

async function saveCapture() {
  if (!state.profile || state.capturing) return;
  state.capturing = true;
  renderVideo();
  try {
    if (await api.capture(selection())) showNotice('Captura salva.');
  } catch (error) { showNotice(error.message, 'error'); }
  finally {
    state.capturing = false;
    renderVideo();
  }
}

byId('add-camera').addEventListener('click', () => openCameraForm());
byId('edit-camera').addEventListener('click', () => openCameraForm(camera()));
byId('connect').addEventListener('click', () => void connectCamera(state.selected));
byId('camera-form').addEventListener('submit', saveCamera);
byId('camera-dialog').addEventListener('close', () => { byId('password').value = ''; });
byId('discover').addEventListener('click', search);
byId('retry-discovery').addEventListener('click', search);
byId('remove-camera').addEventListener('click', () => {
  byId('remove-text').textContent = 'Remover “' + editing.name + '” do cadastro deste aplicativo?';
  byId('remove-dialog').showModal();
});
byId('confirm-remove').addEventListener('click', removeCamera);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => byId(button.dataset.close).close());
}
byId('profiles').addEventListener('change', event => {
  const profile = connection().details?.profiles.find(profile => profile.token === event.target.value);
  activateProfile(profile ?? null, true);
});
byId('toggle-video').addEventListener('click', () => {
  if (['live', 'starting'].includes(state.video.status)) {
    resetVideo();
    renderVideo();
  } else void playVideo();
});
byId('capture').addEventListener('click', saveCapture);
byId('copy-uri').addEventListener('click', async () => {
  try {
    await api.copyUri(selection());
    showNotice('URL RTSP copiada.');
  } catch (error) { showNotice(error.message, 'error'); }
});
byId('fullscreen').addEventListener('click', () => void viewport.requestFullscreen().catch(error => showNotice(error.message, 'error')));

for (const button of document.querySelectorAll('[data-vector]')) {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    startMotion(button, false);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, endMotion);
  button.addEventListener('click', event => { if (!event.detail) startMotion(button, true); });
}
window.addEventListener('blur', endMotion);
byId('ptz-stop').addEventListener('click', () => {
  if (motion) endMotion();
  else {
    const selected = selection();
    void enqueuePtz(() => api.stop(selected)).catch(error => showNotice(error.message, 'error'));
  }
});
byId('goto-preset').addEventListener('click', () => {
  endMotion();
  const input = { ...selection(), preset: byId('presets').value };
  if (input.preset) void enqueuePtz(() => api.gotoPreset(input)).catch(error => showNotice(error.message, 'error'));
});

api.list().then(cameras => {
  state.cameras = cameras;
  if (cameras.length) state.selected = cameras[0].id;
  render();
}).catch(error => showNotice(error.message, 'error'));
