'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { isIPv4 } = require('node:net');
const { request } = require('./http');
const { discover } = require('./discovery');
const { parseXml, children, child, path, value, xml } = require('./xml');

const namespaces = {
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tr2: 'http://www.onvif.org/ver20/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
};
const soapNamespaces = ['http://www.w3.org/2003/05/soap-envelope', 'http://schemas.xmlsoap.org/soap/envelope/'];
const securityRoot = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-';
const addressPath = '/onvif/device_service';

class OnvifError extends Error {
  constructor(message, { status, fault } = {}) {
    super(message);
    this.name = 'OnvifError';
    this.status = status;
    this.fault = fault;
  }
}

function deviceAddress(input) {
  const address = String(input ?? '').trim();
  if (!address) throw new OnvifError('Informe o endereço IP ou a URL ONVIF da câmera.');
  let url;
  try { url = new URL(address.includes('://') ? address : 'http://' + address); } catch {
    throw new OnvifError('Endereço inválido. Use um IP, IP:porta ou uma URL HTTP(S).');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new OnvifError('Use uma URL HTTP(S) sem usuário, senha ou fragmento.');
  }
  if (url.pathname === '/') url.pathname = addressPath;
  return url;
}

function cameraUrl(input, base, protocols) {
  if (!input) throw new OnvifError('A câmera não informou o endereço solicitado.');
  let url;
  try { url = new URL(input, base); } catch {
    throw new OnvifError('A câmera retornou um endereço inválido.');
  }
  if (!protocols.includes(url.protocol)) throw new OnvifError('A câmera retornou um protocolo incompatível.');
  url.hostname = base.hostname;
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function securityHeader(credentials, clockOffset) {
  if (!credentials.username) return '';
  const nonce = randomBytes(20);
  const created = new Date(Date.now() + clockOffset).toISOString();
  const digest = createHash('sha1').update(nonce).update(created).update(credentials.password).digest('base64');
  return `<s:Header><wsse:Security xmlns:wsse="${securityRoot}wssecurity-secext-1.0.xsd" xmlns:wsu="${securityRoot}wssecurity-utility-1.0.xsd"><wsse:UsernameToken>
<wsse:Username>${xml(credentials.username)}</wsse:Username>
<wsse:Password Type="${securityRoot}username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
<wsse:Nonce EncodingType="${securityRoot}soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>
<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}

function authError(error) {
  return [401, 403].includes(error?.status) || /NotAuthorized|FailedAuthentication|InvalidSecurity|MessageExpired/i.test(error?.fault ?? '');
}

function describeError(error) {
  if (authError(error)) return 'A câmera recusou a autenticação. Confira a conta ONVIF configurada no dispositivo.';
  if (error instanceof OnvifError) return error.message;
  const networkErrors = {
    ECONNREFUSED: 'A câmera recusou a conexão nessa porta.',
    EHOSTUNREACH: 'A câmera está inacessível por esta interface de rede.',
    ENETUNREACH: 'Nenhuma rota disponível para a câmera.',
    ENOTFOUND: 'O nome da câmera não foi encontrado.',
    ETIMEDOUT: 'A câmera demorou para responder.',
    ABORT_ERR: 'A câmera demorou para responder.',
    EPERM: 'O sistema bloqueou o acesso à rede local.',
    EACCES: 'O sistema bloqueou o acesso à rede local.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'O certificado HTTPS da câmera não é confiável neste computador.',
    SELF_SIGNED_CERT_IN_CHAIN: 'O certificado HTTPS da câmera não é confiável neste computador.',
    CERT_HAS_EXPIRED: 'O certificado HTTPS da câmera expirou.',
  };
  return networkErrors[error?.code] ?? 'Não foi possível concluir a operação na câmera.';
}

function responseNode(response, operation) {
  let root;
  try { root = parseXml(response.body.toString('utf8')); } catch {
    if (response.status >= 200 && response.status < 300) {
      throw new OnvifError('A resposta recebida não é uma mensagem ONVIF válida.', { status: response.status });
    }
  }
  const body = soapNamespaces.includes(root?.namespace) ? child(root, 'Body') : undefined;
  const fault = child(body, 'Fault');
  if (fault) {
    let code = child(fault, 'Code');
    const codes = [value(fault, 'faultcode')];
    while (code) {
      codes.push(value(code, 'Value'));
      code = child(code, 'Subcode');
    }
    const significant = codes.filter(Boolean).join(' / ');
    const label = significant.replace(/[^\w /:.-]/g, '').slice(0, 140);
    throw new OnvifError(operation + ' foi recusado pela câmera' + (label ? ' (' + label + ').' : '.'), {
      status: response.status, fault: significant,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new OnvifError('A câmera retornou HTTP ' + response.status + ' em ' + operation + '.', { status: response.status });
  }
  const result = child(body, operation + 'Response');
  if (!result) throw new OnvifError('A câmera não retornou a resposta ONVIF esperada para ' + operation + '.', { status: response.status });
  return result;
}

function profilesFrom(response, media) {
  return children(response, 'Profiles').filter(profile => profile.attrs.token).map(profile => {
    const configurations = media === 'tr2' ? child(profile, 'Configurations') : profile;
    const video = child(configurations, media === 'tr2' ? 'VideoEncoder' : 'VideoEncoderConfiguration');
    const ptz = child(configurations, media === 'tr2' ? 'PTZ' : 'PTZConfiguration');
    return {
      token: profile.attrs.token,
      name: value(profile, 'Name') || profile.attrs.token,
      encoding: value(video, 'Encoding'),
      width: Number(value(video, 'Resolution', 'Width')) || null,
      height: Number(value(video, 'Resolution', 'Height')) || null,
      frameRate: Number(value(video, 'RateControl', 'FrameRateLimit')) || null,
      ptz: Boolean(ptz),
    };
  });
}

class OnvifClient {
  constructor(endpoint, credentials = {}) {
    this.endpoint = deviceAddress(endpoint);
    this.credentials = { username: credentials.username ?? '', password: credentials.password ?? '' };
    this.clockOffset = 0;
    this.soapVersion = 0;
    this.services = new Map();
    this.media = '';
    this.profiles = [];
  }

  async soap(url, prefix, operation, fields = '', anonymous = false) {
    const action = namespaces[prefix] + '/' + operation;
    const declarations = Object.entries(namespaces).map(([key, ns]) => `xmlns:${key}="${ns}"`).join(' ');
    const security = anonymous ? '' : securityHeader(this.credentials, this.clockOffset);
    const exchange = async version => {
      const body = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${soapNamespaces[version]}" ${declarations}>${security}<s:Body><${prefix}:${operation}>${fields}</${prefix}:${operation}></s:Body></s:Envelope>`;
      const headers = version === 0
        ? { 'Content-Type': 'application/soap+xml; charset=utf-8; action="' + action + '"' }
        : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"' + action + '"' };
      headers['Content-Length'] = Buffer.byteLength(body);
      return responseNode(await request(url, {
        method: 'POST', headers, body, credentials: anonymous ? undefined : this.credentials,
      }), operation);
    };
    try { return await exchange(this.soapVersion); } catch (error) {
      if (this.soapVersion !== 0 || (error.status !== 415 && !error.fault?.includes('VersionMismatch'))) throw error;
      const result = await exchange(1);
      this.soapVersion = 1;
      return result;
    }
  }

  async readClock() {
    let response;
    try { response = await this.soap(this.endpoint, 'tds', 'GetSystemDateAndTime', '', true); } catch (error) {
      if (!authError(error)) throw error;
      response = await this.soap(this.endpoint, 'tds', 'GetSystemDateAndTime');
    }
    const time = path(response, 'SystemDateAndTime', 'UTCDateTime');
    if (!time) return;
    const stamp = Date.UTC(
      +value(time, 'Date', 'Year'), +value(time, 'Date', 'Month') - 1, +value(time, 'Date', 'Day'),
      +value(time, 'Time', 'Hour'), +value(time, 'Time', 'Minute'), +value(time, 'Time', 'Second'),
    );
    if (Number.isFinite(stamp) && stamp >= Date.UTC(2000, 0, 1)) this.clockOffset = stamp - Date.now();
  }

  addService(prefix, address) {
    if (!address || this.services.has(prefix)) return;
    try { this.services.set(prefix, cameraUrl(address, this.endpoint, ['http:', 'https:'])); } catch {
      // An invalid service address does not invalidate the other advertised services.
    }
  }

  async initialize() {
    await this.readClock().catch(() => {});
    const info = await this.soap(this.endpoint, 'tds', 'GetDeviceInformation');
    this.info = Object.fromEntries(['Manufacturer', 'Model', 'FirmwareVersion', 'SerialNumber', 'HardwareId']
      .map(key => [key[0].toLowerCase() + key.slice(1), value(info, key)]));

    try {
      const response = await this.soap(this.endpoint, 'tds', 'GetServices', '<tds:IncludeCapability>false</tds:IncludeCapability>');
      for (const service of children(response, 'Service')) {
        const prefix = Object.keys(namespaces).find(key => namespaces[key] === value(service, 'Namespace'));
        if (['trt', 'tr2', 'tptz'].includes(prefix)) this.addService(prefix, value(service, 'XAddr'));
      }
    } catch {
      // Legacy devices may only provide service addresses through GetCapabilities.
    }
    if ((!this.services.has('trt') && !this.services.has('tr2')) || !this.services.has('tptz')) {
      try {
        const response = await this.soap(this.endpoint, 'tds', 'GetCapabilities', '<tds:Category>All</tds:Category>');
        const capabilities = child(response, 'Capabilities');
        this.addService('trt', value(capabilities, 'Media', 'XAddr'));
        this.addService('tptz', value(capabilities, 'PTZ', 'XAddr'));
      } catch {
        // Service discovery can still succeed using the GetServices response.
      }
    }

    let profileError;
    for (const prefix of ['tr2', 'trt']) {
      const url = this.services.get(prefix);
      if (!url) continue;
      try {
        const fields = prefix === 'tr2' ? '<tr2:Type>All</tr2:Type>' : '';
        this.profiles = profilesFrom(await this.soap(url, prefix, 'GetProfiles', fields), prefix);
        this.media = prefix;
        if (this.profiles.length) break;
      } catch (error) { profileError = error; }
    }
    return {
      endpoint: this.endpoint.href,
      info: this.info,
      profiles: this.profiles,
      services: [...this.services.keys()].map(key => ({ trt: 'Media', tr2: 'Media2', tptz: 'PTZ' })[key]),
      profileError: this.profiles.length || !profileError ? '' : describeError(profileError),
    };
  }

  profile(token) {
    const profile = this.profiles.find(profile => profile.token === token);
    if (!profile) throw new OnvifError('Selecione um perfil de vídeo disponível.');
    return profile;
  }

  async mediaUri(token, operation) {
    this.profile(token);
    const prefix = this.media;
    const setup = (prefix === 'tr2')
      ? '<tr2:Protocol>RTSP</tr2:Protocol>'
      : '<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>';
    const fields = (operation === 'GetStreamUri' ? setup : '') + `<${prefix}:ProfileToken>${xml(token)}</${prefix}:ProfileToken>`;
    const mediaEndpoint = this.services.get(prefix);
    const response = await this.soap(mediaEndpoint, prefix, operation, fields);
    const uri = value(response, 'MediaUri', 'Uri') || value(response, 'Uri');
    return cameraUrl(uri, mediaEndpoint, operation === 'GetStreamUri' ? ['rtsp:', 'rtsps:'] : ['http:', 'https:']);
  }

  async snapshot(token) {
    this.profile(token);
    this.snapshotUrls ??= new Map();
    let url = this.snapshotUrls.get(token) ?? await this.mediaUri(token, 'GetSnapshotUri');
    let response = await request(url, { credentials: this.credentials, maxBytes: 12 * 1024 * 1024 });
    if ([404, 410].includes(response.status) && this.snapshotUrls.has(token)) {
      this.snapshotUrls.delete(token);
      url = await this.mediaUri(token, 'GetSnapshotUri');
      response = await request(url, { credentials: this.credentials, maxBytes: 12 * 1024 * 1024 });
    }
    if (response.status !== 200) {
      throw new OnvifError('A captura retornou HTTP ' + response.status + '.', { status: response.status });
    }
    const bytes = response.body;
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (!isJpeg && !isPng) throw new OnvifError('A câmera não retornou uma imagem JPEG ou PNG.');
    this.snapshotUrls.set(token, url);
    return { bytes, mime: isJpeg ? 'image/jpeg' : 'image/png' };
  }

  async ptz(token, operation, fields = '') {
    const profile = this.profile(token);
    const url = this.services.get('tptz');
    if (!url || !profile.ptz) throw new OnvifError('O perfil selecionado não oferece controle PTZ.');
    return this.soap(url, 'tptz', operation, '<tptz:ProfileToken>' + xml(token) + '</tptz:ProfileToken>' + fields);
  }

  async move(token, x, y, zoom) {
    const vector = [x, y, zoom];
    if (vector.some(axis => !Number.isFinite(axis) || Math.abs(axis) > 1) || !vector.some(Boolean)) {
      throw new OnvifError('Direção ou velocidade PTZ inválida.');
    }
    const panTilt = x || y ? `<tt:PanTilt x="${x}" y="${y}"/>` : '';
    const zoomNode = zoom ? `<tt:Zoom x="${zoom}"/>` : '';
    await this.ptz(token, 'ContinuousMove', '<tptz:Velocity>' + panTilt + zoomNode + '</tptz:Velocity><tptz:Timeout>PT1S</tptz:Timeout>');
  }

  async stop(token) {
    await this.ptz(token, 'Stop', '<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom>');
  }

  async presets(token) {
    const response = await this.ptz(token, 'GetPresets');
    return children(response, 'Preset').filter(preset => preset.attrs.token).map(preset => ({
      token: preset.attrs.token,
      name: value(preset, 'Name') || preset.attrs.token,
    }));
  }

  async gotoPreset(token, preset) {
    if (typeof preset !== 'string' || !preset || preset.length > 256) throw new OnvifError('Selecione uma posição PTZ.');
    await this.ptz(token, 'GotoPreset', '<tptz:PresetToken>' + xml(preset) + '</tptz:PresetToken>');
  }
}

async function connect(address, credentials) {
  const input = String(address ?? '').trim();
  const url = deviceAddress(input);
  if (!isIPv4(input)) {
    const client = new OnvifClient(url.href, credentials);
    return { client, details: await client.initialize() };
  }

  const devices = await discover(1100, input).catch(() => []);
  const alternatives = devices.map(device => device.endpoint);
  alternatives.push(...['', ':2020', ':8899', ':8000', ':8080', ':5000'].map(port => 'http://' + input + port + addressPath));
  let firstError;
  for (const address of new Set(alternatives)) {
    const client = new OnvifClient(address, credentials);
    try { return { client, details: await client.initialize() }; } catch (error) {
      if (authError(error)) throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}

module.exports = { connect, OnvifClient, OnvifError, describeError, deviceAddress };
