'use strict';
// Proxmox App Store - zero-dependency Node.js server.
// Talks to the Proxmox VE API with an API token; serves the web UI in public/.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), os = require('os');

const PORT = Number(process.env.PORT || 80);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const APPS_FILE = path.join(DATA, 'apps.json');
// Development only: use an existing login ticket instead of an API token.
const DEV = process.env.PVE_TICKET
  ? { ticket: process.env.PVE_TICKET, csrf: process.env.PVE_CSRF, host: process.env.PVE_HOST } : null;

fs.mkdirSync(DATA, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

let config = readJson(CONFIG_FILE, null);
let apps = readJson(APPS_FILE, {});           // vmid -> { appId, name, port, path, image }
const catalog = readJson(path.join(__dirname, 'catalog.json'), []);
const sessions = new Map();                    // token -> expiry
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Proxmox API ----------
function pve(method, p, params, cfg = config && config.pve) {
  return new Promise((resolve, reject) => {
    const hasBody = params && method !== 'GET' && method !== 'DELETE';
    const qs = params ? new URLSearchParams(params).toString() : '';
    const headers = {};
    if (DEV) { headers.Cookie = 'PVEAuthCookie=' + DEV.ticket; headers.CSRFPreventionToken = DEV.csrf; }
    else headers.Authorization = `PVEAPIToken=${cfg.tokenId}=${cfg.secret}`;
    if (hasBody) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(qs); }
    const req = https.request({
      host: cfg.host, port: cfg.port || 8006, method, headers, timeout: 30000,
      path: '/api2/json' + p + (!hasBody && qs ? '?' + qs : ''),
      rejectUnauthorized: false, // Proxmox uses a self-signed certificate by default
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j ? j.data : null);
        let msg = (j && j.message) || res.statusMessage || 'HTTP ' + res.statusCode;
        if (j && j.errors) msg += ' ' + JSON.stringify(j.errors);
        const e = new Error('Proxmox: ' + String(msg).replace(/\s+/g, ' ').trim()); e.status = res.statusCode; reject(e);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox API timed out')));
    req.on('error', e => reject(new Error('Cannot reach Proxmox: ' + e.message)));
    if (hasBody) req.write(qs);
    req.end();
  });
}
const node = () => '/nodes/' + config.pve.node;

async function waitTask(upid, timeoutMs = 20 * 60 * 1000, onLog) {
  const t0 = Date.now(), base = `${node()}/tasks/${encodeURIComponent(upid)}`;
  while (Date.now() - t0 < timeoutMs) {
    const s = await pve('GET', base + '/status');
    if (onLog) { try { const l = await pve('GET', base + '/log', { start: 0, limit: 500 }); if (l.length) onLog(l[l.length - 1].t); } catch {} }
    if (s.status === 'stopped') {
      if (s.exitstatus === 'OK' || /^WARNINGS/.test(s.exitstatus || '')) return;
      let tail = '';
      try { tail = (await pve('GET', base + '/log', { start: 0, limit: 500 })).map(l => l.t).filter(t => !/^TASK/.test(t)).slice(-3).join(' | '); } catch {}
      throw new Error(`Task failed: ${s.exitstatus}${tail ? ' - ' + tail : ''}`);
    }
    await sleep(1500);
  }
  throw new Error('Task timed out');
}

// ---------- guests overview ----------
const cache = new Map();
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  let v; try { v = await fn(); } catch { v = null; }
  cache.set(key, { t: Date.now(), v });
  return v;
}
const ownIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal).map(i => i.address);
const firstIp = list => {
  for (const i of list || []) {
    if (i.name === 'lo' || /^(docker|br-|veth)/.test(i.name || '')) continue;
    for (const a of i['ip-addresses'] || []) if (a['ip-address-type'] === 'ipv4' || a['ip-address-type'] === 'inet') {
      if (!a['ip-address'].startsWith('127.')) return a['ip-address'];
    }
  }
  return null;
};
// Link for the Open button. Apps marked "https" in the catalog only answer on https.
const appUrl = (ip, a) => `${a.https ? 'https' : 'http'}://${ip}${a.port == (a.https ? 443 : 80) ? '' : ':' + a.port}${a.path || ''}`;
async function guestIp(g) {
  if (g.status !== 'running') return null;
  if (g.type === 'lxc') return cached('ip' + g.vmid, 15000, async () => firstIp(await pve('GET', `${node()}/lxc/${g.vmid}/interfaces`)));
  return cached('ip' + g.vmid, 60000, async () => firstIp((await pve('GET', `${node()}/qemu/${g.vmid}/agent/network-get-interfaces`)).result));
}
async function listGuests() {
  const [res, nodeStatus] = await Promise.all([
    pve('GET', '/cluster/resources'),
    cached('node', 4000, () => pve('GET', node() + '/status')),
  ]);
  const mine = ownIps();
  const guests = await Promise.all(res.filter(r => r.type === 'lxc' || r.type === 'qemu').map(async g => {
    const [ip, cfg] = await Promise.all([
      guestIp(g),
      cached('cfg' + g.vmid, 120000, () => pve('GET', `${node()}/${g.type}/${g.vmid}/config`)),
    ]);
    const app = apps[g.vmid];
    let url = null;
    if (app && ip && app.port) url = appUrl(ip, app);
    else if (cfg && cfg.description) { const m = /https?:\/\/[^\s"'<>]+/.exec(cfg.description); if (m && !/community-scripts|github|shields\.io/.test(m[0])) url = m[0]; }
    return {
      vmid: g.vmid, name: g.name, type: g.type, status: g.status, cpu: g.cpu || 0, maxcpu: g.maxcpu,
      mem: g.mem || 0, maxmem: g.maxmem, disk: g.disk || 0, maxdisk: g.maxdisk, uptime: g.uptime || 0,
      tags: g.tags ? g.tags.split(/[;, ]+/).filter(Boolean) : [], ip, url,
      app: app ? app.appId : null, image: app ? app.image : null, self: !!ip && mine.includes(ip), onboot: !!(cfg && cfg.onboot),
    };
  }));
  guests.sort((a, b) => a.vmid - b.vmid);
  const storages = res.filter(r => r.type === 'storage').map(s => ({ name: s.storage, used: s.disk, total: s.maxdisk }));
  const n = res.find(r => r.type === 'node' && r.node === config.pve.node) || {};
  return {
    guests, storages,
    host: { name: config.pve.node, cpu: n.cpu || 0, maxcpu: n.maxcpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime,
      version: nodeStatus && nodeStatus.pveversion },
  };
}

// ---------- install jobs (run one at a time) ----------
const jobs = []; let jobSeq = 0, running = false;
function normImage(ref) {
  ref = String(ref || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  if (!/^[a-z0-9][a-z0-9._\-/:]*$/.test(ref)) throw new Error('Invalid image name');
  const parts = ref.split('/');
  if (!/[.:]/.test(parts[0]) || parts.length === 1) ref = 'docker.io/' + (parts.length === 1 ? 'library/' : '') + ref;
  if (!/:[\w.-]+$/.test(ref.split('/').pop())) ref += ':latest';
  return ref;
}
function queueInstall(body) {
  let app = catalog.find(a => a.id === body.appId);
  if (!app) {
    if (body.appId !== 'custom') throw new Error('Unknown app');
    app = { id: 'custom', name: body.hostname, image: body.image, port: Number(body.port) || 80, env: [] };
  }
  const P = config.pve, adv = body.advanced || {};
  // Advanced options: every one is optional and falls back to the simple default.
  const image = normImage(adv.image || app.image);
  const opt = { storage: P.storage, bridge: P.bridge, ip: 'dhcp', gw: '', swap: 0, onboot: 1, start: true, vmid: null };
  const ipv4 = IPV4;
  if (adv.storage) { if (!/^[A-Za-z][\w.-]*$/.test(adv.storage)) throw new Error('Invalid storage'); opt.storage = adv.storage; }
  if (adv.bridge) { if (!/^[A-Za-z][\w.-]*$/.test(adv.bridge)) throw new Error('Invalid network bridge'); opt.bridge = adv.bridge; }
  if (adv.ip && adv.ip !== 'dhcp') {
    if (!new RegExp(`^${ipv4}/([1-9]|[12]\\d|3[0-2])$`).test(adv.ip)) throw new Error('Static address must look like 192.168.1.50/24');
    if (adv.gw && !new RegExp(`^${ipv4}$`).test(adv.gw)) throw new Error('Gateway must be an IP address like 192.168.1.1');
    opt.ip = adv.ip; opt.gw = adv.gw || '';
  }
  if (adv.vmid !== undefined && adv.vmid !== '') { opt.vmid = Number(adv.vmid); if (!(Number.isInteger(opt.vmid) && opt.vmid >= 100 && opt.vmid <= 999999999)) throw new Error('Container ID must be a number from 100'); }
  if (adv.swap !== undefined && adv.swap !== '') { opt.swap = Math.round(Number(adv.swap)); if (!(opt.swap >= 0 && opt.swap <= 262144)) throw new Error('Swap value out of range'); }
  if (adv.onboot !== undefined) opt.onboot = adv.onboot ? 1 : 0;
  if (adv.start !== undefined) opt.start = !!adv.start;
  const hostname = String(body.hostname || app.id).toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new Error('Name may only contain a-z, 0-9 and "-"');
  const num = (v, d, min, max) => { const n = Math.round(Number(v ?? d)); if (!(n >= min && n <= max)) throw new Error('Resource value out of range'); return n; };
  const env = {};
  for (const [k, v] of Object.entries(body.env || {})) {
    if (!/^\w+$/.test(k) || /[\x00-\x1f\x7f]/.test(String(v))) throw new Error('Invalid environment variable: ' + k);
    if (String(v) !== '') env[k] = String(v);
  }
  const job = {
    id: ++jobSeq, appId: app.id, appName: app.name, hostname, image, env, port: app.port, path: app.path || '', https: !!app.https, opt,
    cores: num(body.cores, app.cores || 1, 1, 64), memory: num(body.memory, app.memory || 512, 64, 262144),
    disk: num(body.disk, app.disk || 4, 1, 2000),
    status: 'queued', step: 'Waiting in queue', log: [], started: Date.now(), vmid: null, ip: null, url: null, error: null,
  };
  jobs.unshift(job); if (jobs.length > 30) jobs.pop();
  pump();
  return job;
}
async function pump() {
  if (running) return;
  running = true;
  for (let job; (job = jobs.filter(j => j.status === 'queued').pop());) {
    job.status = 'running';
    try { await runInstall(job); job.status = 'done'; job.step = job.opt.start ? 'Installed' : 'Installed, not started'; }
    catch (e) { job.status = 'failed'; job.error = e.message; }
    job.finished = Date.now();
  }
  running = false;
}
async function runInstall(job) {
  const step = s => { job.step = s; job.log.push(s); };
  const P = config.pve;
  const file = 'appstore-' + job.image.replace(/^docker\.io\/(library\/)?/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const tmplDir = `${node()}/storage/${P.tmplStorage}`;
  const findTmpl = async () => (await pve('GET', tmplDir + '/content', { content: 'vztmpl' })).find(c => c.volid.endsWith(`/${file}.tar`));

  step(`Downloading image ${job.image}`);
  let tmpl = await findTmpl();
  if (!tmpl) {
    const up = await pve('POST', tmplDir + '/oci-registry-pull', { reference: job.image, filename: file });
    await waitTask(up, 30 * 60 * 1000, t => { job.step = `Downloading image: ${t}`.slice(0, 120); });
    tmpl = await findTmpl();
    if (!tmpl) throw new Error('Image was downloaded but not found on storage ' + P.tmplStorage);
  }
  try {
    const O = job.opt;
    job.vmid = O.vmid || Number(await pve('GET', '/cluster/nextid'));
    step(`Creating container ${job.vmid} (${job.hostname})`);
    await waitTask(await pve('POST', node() + '/lxc', {
      vmid: job.vmid, hostname: job.hostname, ostemplate: tmpl.volid, rootfs: `${O.storage}:${job.disk}`,
      cores: job.cores, memory: job.memory, swap: O.swap, unprivileged: 1, onboot: O.onboot,
      net0: `name=eth0,bridge=${O.bridge},ip=${O.ip}${O.gw ? ',gw=' + O.gw : ''},type=veth`,
      tags: `appstore;${job.appId}`.replace(/[^a-z0-9;_-]/g, ''),
      description: `Installed by App Store\n\nApp: ${job.appName}\n\nImage: ${job.image}\n`,
    }));
  } finally {
    // Remove the downloaded image so the next install always pulls a fresh copy.
    pve('DELETE', `${tmplDir}/content/${encodeURIComponent(tmpl.volid)}`).catch(() => {});
  }
  apps[job.vmid] = { appId: job.appId, name: job.appName, port: job.port, path: job.path, https: job.https, image: job.image };
  writeJson(APPS_FILE, apps);

  if (Object.keys(job.env).length) {
    step('Applying settings');
    const cfg = await pve('GET', `${node()}/lxc/${job.vmid}/config`);
    const merged = {};
    for (const kv of (cfg.env || '').split('\0').filter(Boolean)) { const i = kv.indexOf('='); merged[kv.slice(0, i)] = kv.slice(i + 1); }
    Object.assign(merged, job.env);
    await pve('PUT', `${node()}/lxc/${job.vmid}/config`, { env: Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\0') });
  }
  if (!job.opt.start) { cache.clear(); return; }
  step('Starting container');
  await waitTask(await pve('POST', `${node()}/lxc/${job.vmid}/status/start`));
  step('Waiting for network address');
  for (let i = 0; i < 30 && !job.ip; i++) {
    await sleep(2000);
    job.ip = firstIp(await pve('GET', `${node()}/lxc/${job.vmid}/interfaces`).catch(() => []));
    // Apps without a web UI (port 0) get no Open link.
    if (job.ip && job.port) job.url = appUrl(job.ip, job);
  }
  const st = await pve('GET', `${node()}/lxc/${job.vmid}/status/current`);
  if (st.status !== 'running') throw new Error('The container was created but stopped right after starting. This image may not be compatible with LXC.');
  cache.clear();
}

// ---------- guest actions ----------
async function guestAction(type, vmid, action) {
  if (!['lxc', 'qemu'].includes(type) || !/^\d+$/.test(vmid)) throw new Error('Bad request');
  const data = await listGuests();
  const g = data.guests.find(x => String(x.vmid) === vmid && x.type === type);
  if (!g) throw new Error('Guest not found');
  if (g.self && action !== 'start') throw new Error('This is the App Store itself - manage it from the Proxmox UI.');
  const base = `${node()}/${type}/${vmid}`;
  let upid;
  if (['start', 'stop', 'shutdown', 'reboot'].includes(action)) upid = await pve('POST', `${base}/status/${action}`);
  else if (action === 'delete') {
    // Ask the guest directly: the cluster overview lags a few seconds behind.
    if ((await pve('GET', base + '/status/current')).status !== 'stopped') throw new Error('Stop it before deleting.');
    upid = await pve('DELETE', base, { purge: 1, 'destroy-unreferenced-disks': 1 });
    delete apps[vmid]; writeJson(APPS_FILE, apps);
  } else throw new Error('Unknown action');
  await waitTask(upid, 90000).catch(e => { if (!/timed out/.test(e.message)) throw e; });
  cache.clear();
}

// ---------- guest settings (Manage page) ----------
const IPV4 = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
// "a=1,b=2" property strings, as Proxmox uses for net0 and rootfs.
const parseKv = str => Object.fromEntries(String(str || '').split(',').filter(Boolean).map(p => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }));
const joinKv = o => Object.entries(o).map(([k, v]) => v === '' ? k : `${k}=${v}`).join(',');
const parseEnv = str => String(str || '').split('\0').filter(Boolean).map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; });
const int = (v, min, max, what) => { const n = Number(v); if (v === '' || v == null || !(Number.isInteger(n) && n >= min && n <= max)) throw new Error(`${what} must be a whole number from ${min} to ${max}`); return n; };

async function guestSettings(type, vmid) {
  const data = await listGuests();
  const g = data.guests.find(x => String(x.vmid) === vmid && x.type === type);
  if (!g) throw new Error('Guest not found');
  const lxc = type === 'lxc', cfg = await pve('GET', `${node()}/${type}/${vmid}/config`);
  const sockets = lxc ? 1 : Number(cfg.sockets) || 1;
  const s = {
    self: g.self, sockets, hostCores: data.host.maxcpu || 64,
    name: (lxc ? cfg.hostname : cfg.name) || g.name,
    cores: cfg.cores ? cfg.cores * sockets : g.maxcpu,   // a container without a limit uses every host core
    memory: Number((/\d+/.exec(String(cfg.memory ?? '')) || [512])[0]),
    onboot: !!Number(cfg.onboot),
  };
  if (lxc) {
    s.swap = Number(cfg.swap ?? 512);
    const m = /size=(\d+(?:\.\d+)?)([MGT])/.exec(cfg.rootfs || '');
    s.disk = m ? m[1] * { M: 1 / 1024, G: 1, T: 1024 }[m[2]] : null;   // GB
    if (cfg.net0) { s.net0 = parseKv(cfg.net0); s.net = { bridge: s.net0.bridge || '', ip: s.net0.ip || '', gw: s.net0.gw || '' }; }
    s.envRaw = cfg.env || ''; s.env = parseEnv(cfg.env);
    const app = apps[vmid] || {};
    s.image = app.image || null;
    s.web = { port: Number(app.port) || 0, path: app.path || '', https: !!app.https };
  }
  return s;
}

// Container settings tab: applies only the values that differ from the current ones.
async function saveContainer(type, vmid, b) {
  const cur = await guestSettings(type, vmid), lxc = type === 'lxc', base = `${node()}/${type}/${vmid}`;
  if (cur.self) throw new Error('This is the App Store itself - manage it from the Proxmox UI.');
  const set = {};
  const name = String(b.name ?? cur.name).trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(name)) throw new Error('Name may only contain letters, digits, "-" and "."');
  if (name !== cur.name) set[lxc ? 'hostname' : 'name'] = name;
  const cores = int(b.cores, 1, cur.hostCores, 'CPU cores'), memory = int(b.memory, 64, 262144, 'Memory');
  if (cores !== cur.cores) { set.cores = cores; if (cur.sockets > 1) set.sockets = 1; }
  if (memory !== cur.memory) set.memory = memory;
  if (!!b.onboot !== cur.onboot) set.onboot = b.onboot ? 1 : 0;
  let grow = 0;
  if (lxc) {
    if (b.swap !== undefined) { const swap = int(b.swap, 0, 262144, 'Swap'); if (swap !== cur.swap) set.swap = swap; }
    if (b.net && cur.net0) {
      const n = { ...cur.net0 }, want = b.net;
      if (want.bridge) { if (!/^[A-Za-z][\w.-]*$/.test(want.bridge)) throw new Error('Invalid network bridge'); n.bridge = want.bridge; }
      if (want.ip === 'dhcp') { n.ip = 'dhcp'; delete n.gw; }
      else if (want.ip && want.ip !== 'keep') {
        if (!new RegExp(`^${IPV4}/([1-9]|[12]\\d|3[0-2])$`).test(want.ip)) throw new Error('Static address must look like 192.168.1.50/24');
        if (want.gw && !new RegExp(`^${IPV4}$`).test(want.gw)) throw new Error('Gateway must be an IP address like 192.168.1.1');
        n.ip = want.ip; if (want.gw) n.gw = want.gw; else delete n.gw;
      }
      if (joinKv(n) !== joinKv(cur.net0)) set.net0 = joinKv(n);
    }
    if (cur.disk != null && b.disk !== undefined && b.disk !== '') {
      const d = int(b.disk, 1, 2000, 'Disk size');
      if (d < Math.floor(cur.disk)) throw new Error('A disk can only be made larger');
      if (d > Math.ceil(cur.disk)) grow = d;
    }
  }
  if (Object.keys(set).length) await pve('PUT', base + '/config', set);
  if (grow) { const up = await pve('PUT', base + '/resize', { disk: 'rootfs', size: grow + 'G' }); if (typeof up === 'string' && up.startsWith('UPID')) await waitTask(up, 5 * 60 * 1000); }
  cache.clear();
  return { ok: true, changed: Object.keys(set).length + (grow ? 1 : 0) };
}

// App settings tab: environment variables and the link behind the Open button.
async function saveApp(vmid, b) {
  const cur = await guestSettings('lxc', vmid);
  if (cur.self) throw new Error('This is the App Store itself - manage it from the Proxmox UI.');
  let envChanged = false, webChanged = false;
  if (b.env) {
    const list = [];
    for (const [k, v] of Object.entries(b.env)) {
      if (!/^\w+$/.test(k) || /[\x00-\x1f\x7f]/.test(String(v))) throw new Error('Invalid environment variable: ' + k);
      list.push(`${k}=${v}`);
    }
    const env = list.join('\0');
    if (env !== cur.envRaw) { await pve('PUT', `${node()}/lxc/${vmid}/config`, env ? { env } : { delete: 'env' }); envChanged = true; }
  }
  if (b.web) {
    const port = int(b.web.port || 0, 0, 65535, 'Web port'), p = String(b.web.path || '').trim(), https = !!b.web.https;
    if (!/^(\/[^\s"'<>]*)?$/.test(p)) throw new Error('Path must start with "/"');
    if (port !== cur.web.port || p !== cur.web.path || https !== cur.web.https) {
      apps[vmid] = { appId: 'custom', name: cur.name, image: null, ...apps[vmid], port, path: p, https };
      writeJson(APPS_FILE, apps); webChanged = true;
    }
  }
  cache.clear();
  return { ok: true, envChanged, webChanged };
}

// ---------- setup / auth ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
async function setup(b) {
  if (config) throw new Error('Already configured');
  if (!b.password || String(b.password).length < 8) throw new Error('Choose a password of at least 8 characters');
  const m = /^(?:https?:\/\/)?([^/:\s]+)(?::(\d+))?/.exec(String(b.host || '').trim());
  if (!m) throw new Error('Enter the Proxmox host address');
  const cfg = { host: m[1], port: Number(m[2]) || 8006, tokenId: String(b.tokenId || '').trim(), secret: String(b.secret || '').trim() };
  if (DEV) cfg.host = DEV.host;
  else if (!/^[^!\s]+@[^!\s]+![^!\s]+$/.test(cfg.tokenId) || !cfg.secret) throw new Error('Token ID should look like user@realm!name, with its secret');
  const nodes = await pve('GET', '/nodes', null, cfg);
  if (!nodes || !nodes.length) throw new Error('The token works but cannot see any node - check its permissions');
  cfg.node = nodes[0].node;
  const st = await pve('GET', `/nodes/${cfg.node}/storage`, null, cfg);
  const pick = (kind, prefer) => { const l = st.filter(s => (s.content || '').split(',').includes(kind) && s.active !== 0); return (l.find(s => s.storage === prefer) || l[0] || {}).storage; };
  cfg.storage = pick('rootdir', 'local-lvm'); cfg.tmplStorage = pick('vztmpl', 'local');
  if (!cfg.storage || !cfg.tmplStorage) throw new Error('No storage for containers/templates is visible to this token');
  const br = await pve('GET', `/nodes/${cfg.node}/network`, { type: 'bridge' }, cfg).catch(() => []);
  cfg.bridge = (br.find(x => x.iface === 'vmbr0') || br[0] || { iface: 'vmbr0' }).iface;
  const salt = crypto.randomBytes(16).toString('hex');
  config = { pve: cfg, salt, passHash: hashPw(String(b.password), salt) };
  writeJson(CONFIG_FILE, config);
}
function newSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + 7 * 864e5);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
}
const sid = req => (/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
const authed = req => { const t = sid(req), e = t && sessions.get(t); return !!e && e > Date.now(); };

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('Expected JSON'));
  let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});

async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (p === '/api/state') return send(res, 200, { configured: !!config, authed: authed(req), dev: !!DEV });
  if (p === '/api/setup' && M === 'POST') { await setup(await readBody(req)); newSession(res); return send(res, 200, { ok: true }); }
  if (p === '/api/login' && M === 'POST') {
    const b = await readBody(req); await sleep(400);
    if (!config) throw new Error('Not configured');
    const h = Buffer.from(hashPw(String(b.password || ''), config.salt)), want = Buffer.from(config.passHash);
    if (!crypto.timingSafeEqual(h, want)) return send(res, 401, { error: 'Wrong password' });
    newSession(res); return send(res, 200, { ok: true });
  }
  if (!config || !authed(req)) return send(res, 401, { error: 'Not signed in' });
  if (p === '/api/logout' && M === 'POST') { sessions.delete(sid(req)); return send(res, 200, { ok: true }); }
  if (p === '/api/guests' && M === 'GET') return send(res, 200, await listGuests());
  if (p === '/api/catalog' && M === 'GET') return send(res, 200, catalog);
  if (p === '/api/jobs' && M === 'GET') return send(res, 200, jobs);
  if (p === '/api/changelog' && M === 'GET') return send(res, 200, readJson(path.join(__dirname, 'changelog.json'), []));
  if (p === '/api/options' && M === 'GET') {
    // Choices for the advanced install form.
    const [st, br, nextid] = await Promise.all([
      pve('GET', node() + '/storage', { content: 'rootdir' }).catch(() => []),
      pve('GET', node() + '/network', { type: 'bridge' }).catch(() => []),
      pve('GET', '/cluster/nextid').catch(() => ''),
    ]);
    const P = config.pve, uniq = (a, d) => [...new Set([d, ...a])];
    return send(res, 200, {
      nextid, storage: P.storage, bridge: P.bridge,
      storages: uniq(st.filter(s => s.active !== 0).map(s => s.storage), P.storage).map(name => { const s = st.find(x => x.storage === name); return { name, free: s ? s.avail : null }; }),
      bridges: uniq(br.map(b => b.iface), P.bridge),
    });
  }
  if (p === '/api/install' && M === 'POST') return send(res, 200, queueInstall(await readBody(req)));
  const m = /^\/api\/guests\/(lxc|qemu)\/(\d+)\/(start|stop|shutdown|reboot|delete)$/.exec(p);
  if (m && M === 'POST') { await readBody(req); await guestAction(m[1], m[2], m[3]); return send(res, 200, { ok: true }); }
  const c = /^\/api\/guests\/(lxc|qemu)\/(\d+)\/(config|app)$/.exec(p);
  if (c && c[3] === 'config' && M === 'GET') {
    const s = await guestSettings(c[1], c[2]);
    if (c[1] === 'lxc') s.bridges = (await pve('GET', node() + '/network', { type: 'bridge' }).catch(() => [])).map(x => x.iface);
    return send(res, 200, s);
  }
  if (c && c[3] === 'config' && M === 'POST') return send(res, 200, await saveContainer(c[1], c[2], await readBody(req)));
  if (c && c[3] === 'app' && c[1] === 'lxc' && M === 'POST') return send(res, 200, await saveApp(c[2], await readBody(req)));
  send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => send(res, e.status === 401 ? 502 : 400, { error: e.message }));
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('index.html missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`App Store listening on :${PORT}${config ? '' : ' (waiting for first-run setup)'}`));
