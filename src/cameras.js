'use strict';

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { OnvifError, deviceAddress } = require('./onvif/client');

class Cameras {
  constructor(file, safeStorage) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.passwords = new Map();
    try {
      this.records = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(this.records)) throw new Error('Formato inválido');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Não foi possível ler o cadastro local de câmeras.', { cause: error });
      this.records = [];
    }
  }

  get(id) {
    const record = this.records.find(record => record.id === id);
    if (!record) throw new OnvifError('A câmera não está cadastrada.');
    return record;
  }

  list() {
    return this.records.map(({ secret, ...record }) => ({ ...record, hasPassword: Boolean(secret) }));
  }

  password(id) {
    const { secret } = this.get(id);
    if (this.passwords.has(id)) return this.passwords.get(id);
    if (!secret) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(secret, 'base64'));
    } catch {
      throw new OnvifError('A senha salva está indisponível. Edite a câmera e informe a senha novamente.');
    }
  }

  write(records) {
    const temporary = this.file + '.tmp';
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.records = records;
    } catch {
      throw new OnvifError('Não foi possível gravar o cadastro local de câmeras.');
    }
  }

  save(input) {
    const existing = input.id ? this.get(input.id) : undefined;
    const name = String(input.name ?? '').trim();
    const address = String(input.address ?? '').trim();
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    const url = deviceAddress(address);
    if (name.length > 100 || address.length > 500 || username.length > 150 || password.length > 500) {
      throw new OnvifError('Um dos campos excede o tamanho permitido.');
    }

    const id = existing?.id ?? randomUUID();
    const record = { id, name: name || url.hostname, address, username };
    const preserve = existing?.username === username && existing?.address === address && !password;
    const effectivePassword = password || (preserve ? this.password(id) : '');
    if (input.remember && effectivePassword) {
      if (preserve && existing.secret) record.secret = existing.secret;
      else {
        if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
          throw new OnvifError('O cofre de senhas do sistema está indisponível. Desmarque a opção de salvar senha para continuar.');
        }
        try {
          record.secret = this.safeStorage.encryptString(effectivePassword).toString('base64');
        } catch {
          throw new OnvifError('O cofre de senhas do sistema recusou a gravação.');
        }
      }
    }
    this.write(existing ? this.records.map(item => item.id === id ? record : item) : [...this.records, record]);
    this.passwords.set(id, effectivePassword);
    return this.list().find(item => item.id === id);
  }

  remove(id) {
    this.get(id);
    this.write(this.records.filter(record => record.id !== id));
    this.passwords.delete(id);
  }
}

module.exports = { Cameras };
