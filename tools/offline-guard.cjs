// Publication copies: deny network I/O outside the owned local demo ports.
const net = require('node:net');
const allowedPorts = new Set([3180, 4173, 4174]);
function allowed(host, port) { return ['127.0.0.1','localhost','::1','[::1]'].includes(String(host)) && allowedPorts.has(Number(port)); }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const arg = args[0];
  const opt = typeof arg === 'object' && arg !== null ? arg : {port:arg, host:typeof args[1] === 'string' ? args[1] : 'localhost'};
  if (opt.path && String(opt.path).startsWith('/')) return originalConnect.apply(this,args);
  if (!allowed(opt.host ?? 'localhost', opt.port)) throw Error('Publication offline guard blocked network connection');
  return originalConnect.apply(this,args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80))) throw Error('Publication offline guard blocked fetch');
  return originalFetch(input,init);
};
