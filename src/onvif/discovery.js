'use strict';

const dgram = require('node:dgram');
const { networkInterfaces } = require('node:os');
const { randomUUID } = require('node:crypto');
const { parseXml, path, children, value } = require('./xml');

const group = '239.255.255.250';
const port = 3702;
const versions = [
  { discovery: 'http://schemas.xmlsoap.org/ws/2005/04/discovery', addressing: 'http://schemas.xmlsoap.org/ws/2004/08/addressing', to: 'urn:schemas-xmlsoap-org:ws:2005:04:discovery' },
  { discovery: 'http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01', addressing: 'http://www.w3.org/2005/08/addressing', to: 'urn:docs-oasis-open-org:ws-dd:ns:discovery:2009:01' },
];

function probe(version, typed) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="${version.addressing}" xmlns:d="${version.discovery}" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<s:Header><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID><a:To>${version.to}</a:To><a:Action>${version.discovery}/Probe</a:Action></s:Header>
<s:Body><d:Probe>${typed ? '<d:Types>dn:NetworkVideoTransmitter</d:Types>' : ''}</d:Probe></s:Body></s:Envelope>`);
}

function nameFromScopes(scopes) {
  const prefix = 'onvif://www.onvif.org/name/';
  const name = scopes.find(scope => scope.startsWith(prefix))?.slice(prefix.length) ?? '';
  try { return decodeURIComponent(name); } catch { return name; }
}

function matches(message, remote) {
  const root = parseXml(message.toString('utf8'));
  const matches = children(path(root, 'Body', 'ProbeMatches'), 'ProbeMatch');
  return matches.flatMap(match => {
    const endpointId = value(match, 'EndpointReference', 'Address');
    const types = value(match, 'Types').split(/\s+/);
    const scopes = value(match, 'Scopes').split(/\s+/);
    const xaddrs = value(match, 'XAddrs').split(/\s+/).filter(address => {
      try {
        const url = new URL(address);
        return ['http:', 'https:'].includes(url.protocol) && url.hostname === remote.address && !url.username && !url.password;
      } catch { return false; }
    });
    if (!xaddrs.length || !types.some(type => /(?:^|:)(?:NetworkVideoTransmitter|Device)$/.test(type))
      && !scopes.some(scope => scope.startsWith('onvif://www.onvif.org/'))) return [];
    return [{
      id: endpointId || xaddrs[0],
      host: remote.address,
      endpoint: xaddrs[0],
      name: nameFromScopes(scopes) || remote.address,
    }];
  });
}

function ipv4Interfaces() {
  return Object.values(networkInterfaces()).flat().filter(entry => entry?.family === 'IPv4' && !entry.internal);
}

function probeInterface(address, timeout, target) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const devices = new Map();
    let retry;
    let finished = false;
    const deadline = setTimeout(finish, timeout);

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      socket.close();
      if (error) reject(error);
      else resolve([...devices.values()]);
    }

    function send(version, typed) {
      socket.send(probe(version, typed), port, target, error => { if (error) finish(error); });
    }

    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      if (target !== group && remote.address !== target) return;
      try {
        for (const device of matches(message, remote)) devices.set(device.id, device);
      } catch {
        // Other devices can send unrelated or malformed datagrams to the socket.
      }
    });
    socket.bind(0, address, () => {
      if (finished) return;
      try {
        if (target === group) {
          socket.setMulticastInterface(address);
          socket.setMulticastTTL(1);
        }
        send(versions[0], true);
        retry = setTimeout(() => {
          for (const version of versions) send(version, false);
        }, 350);
      } catch (error) { finish(error); }
    });
  });
}

async function discover(timeout = 2400, target = group) {
  const addresses = [...new Set(ipv4Interfaces().map(entry => entry.address))];
  if (!addresses.length) throw new Error('Nenhuma interface IPv4 de rede local está ativa.');
  const results = await Promise.allSettled(addresses.map(address => probeInterface(address, timeout, target)));
  const successes = results.filter(result => result.status === 'fulfilled');
  if (!successes.length) throw results[0].reason;
  const devices = new Map(successes.flatMap(result => result.value).map(device => [device.id, device]));
  return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

module.exports = { discover, ipv4Interfaces };
