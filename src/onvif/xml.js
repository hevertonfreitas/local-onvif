'use strict';

const { SaxesParser } = require('saxes');

function parseXml(source) {
  const stack = [];
  let root;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('DOCTYPE não é permitido em mensagens ONVIF.'); });
  parser.on('opentag', tag => {
    if (stack.length >= 80) throw new Error('A resposta XML excede o limite de profundidade.');
    const node = {
      name: tag.local,
      namespace: tag.uri,
      attrs: Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.local, attr.value])),
      children: [],
      text: '',
    };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const addText = value => { if (stack.length) stack.at(-1).text += value; };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => stack.pop());
  parser.write(source).close();
  return root;
}

const children = (node, name) => node?.children.filter(item => item.name === name) ?? [];
const child = (node, name) => children(node, name)[0];
const path = (node, ...names) => names.reduce(child, node);
const value = (node, ...names) => path(node, ...names)?.text.trim() ?? '';

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

module.exports = { parseXml, children, child, path, value, xml };
