'use strict';
// Proxmox App Store - zero-dependency Node.js server.
// Talks to the Proxmox VE API with an API token; serves the web UI in public/.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), os = require('os');
const { waitNet, wrappable, capture, summary, LOG } = require('./entrypoint');

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
      // Success; a task that ended with warnings returns them (DHCP failing at container start is one).
      if (s.exitstatus === 'OK') return [];
      if (/^WARNINGS/.test(s.exitstatus || '')) {
        try { return (await pve('GET', base + '/log', { start: 0, limit: 500 })).map(l => l.t).filter(t => /^WARN|failed/i.test(t) && !/^TASK/.test(t)); } catch { return []; }
      }
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
      netin: g.netin || 0, netout: g.netout || 0,
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
// What the store shows: every app with the result of its compatibility test (tools/compat.js writes compat.json).
// A result only counts for the image it was made with, so an app whose image is changed is "untested" again.
const compat = readJson(path.join(__dirname, 'compat.json'), {});
const catalogView = catalog.map(a => {
  let c = compat[a.id]; try { if (c && c.image !== normImage(a.image)) c = null; } catch { c = null; }
  return { ...a, tested: !c ? 'untested' : c.ok ? 'ok' : 'fails', testDate: c ? c.date : undefined, testPve: c ? c.pve : undefined, testNote: c && !c.ok ? c.error : undefined };
});
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
    const make = extra => pve('POST', node() + '/lxc', {
      vmid: job.vmid, hostname: job.hostname, ostemplate: tmpl.volid, rootfs: `${O.storage}:${job.disk}`,
      cores: job.cores, memory: job.memory, swap: O.swap, unprivileged: 1, onboot: O.onboot,
      net0: `name=eth0,bridge=${O.bridge},ip=${O.ip}${O.gw ? ',gw=' + O.gw : ''},type=veth`,
      tags: `appstore;${job.appId}`.replace(/[^a-z0-9;_-]/g, ''),
      description: `Installed by App Store\n\nApp: ${job.appName}\n\nImage: ${job.image}\n`, ...extra,
    }).then(up => waitTask(up));
    // Proxmox looks inside the image to see which Linux it is. For one it does not know, say so up front.
    await make({}).catch(async e => { if (!/OS distribution|os-release|\/etc\/passwd/i.test(e.message)) throw e; await sleep(5000); await make({ ostype: 'unmanaged' }); });
  } finally {
    // Remove the downloaded image so the next install always pulls a fresh copy.
    pve('DELETE', `${tmplDir}/content/${encodeURIComponent(tmpl.volid)}`).catch(() => {});
  }
  apps[job.vmid] = { appId: job.appId, name: job.appName, port: job.port, path: job.path, https: job.https, image: job.image };
  writeJson(APPS_FILE, apps);

  const base = `${node()}/lxc/${job.vmid}`, cfg = await pve('GET', base + '/config'), set = {};
  if (Object.keys(job.env).length) {
    step('Applying settings');
    const merged = {};
    for (const kv of (cfg.env || '').split('\0').filter(Boolean)) { const i = kv.indexOf('='); merged[kv.slice(0, i)] = kv.slice(i + 1); }
    Object.assign(merged, job.env);
    set.env = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\0');
  }
  // Proxmox connects the network a few seconds after the app has started. An app that needs it at once (to
  // download something, say) would give up and stop, so the start command first waits for the network.
  // Only when the app is started now: that is how we find out whether the image can run the wrapper at all.
  const own = cfg.entrypoint, wrap = job.opt.start && wrappable(own);
  if (wrap) set.entrypoint = waitNet(own);
  if (Object.keys(set).length) await pve('PUT', base + '/config', set);
  if (!job.opt.start) { cache.clear(); return; }

  // Starts the container and watches it until it has a network address. Returns why it failed, or null.
  // Proxmox does DHCP for these containers from the host when they start; when that fails, the start task
  // only warns. Those warnings are kept, since an app that needs the network cannot run without it.
  const warnings = new Set();
  const boot = async () => {
    try { for (const w of await waitTask(await pve('POST', base + '/status/start'), 3 * 60 * 1000)) warnings.add(w.replace(/^WARN:\s*/, '')); }
    catch (e) { return 'Proxmox could not start the container: ' + e.message; }
    step('Waiting for network address');
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      if ((await pve('GET', base + '/status/current')).status !== 'running') return 'stopped';
      job.ip = firstIp(await pve('GET', base + '/interfaces').catch(() => []));
      if (job.ip) return null;
    }
    return null;   // running without an address: the app is installed, the overview shows the address once there is one
  };
  const halt = async () => { if ((await pve('GET', base + '/status/current')).status !== 'stopped') await waitTask(await pve('POST', base + '/status/stop'), 60000).catch(() => {}); };
  step('Starting container');
  let failed = await boot();
  if (failed && wrap) {
    // It may be the wrapper: an image without a shell cannot run it. Try the image's own start command.
    step('Starting container again');
    // Proxmox needs a moment to tidy up after a start that failed, or the next start trips over it.
    await halt(); await sleep(8000); await pve('PUT', base + '/config', { entrypoint: own });
    failed = await boot();
    if (failed && /monitor socket|not running|timeout/i.test(failed)) { await halt(); await sleep(15000); failed = await boot(); }
    if (failed) {
      // The app itself gives up. Run it once more with its output saved, so the reason can be shown.
      step('Finding out why it stopped');
      job.detail = await startOutput(job.vmid, base, own).catch(() => null);
      await halt().catch(() => {}); await pve('PUT', base + '/config', { entrypoint: waitNet(own) }).catch(() => {});
    }
  }
  cache.clear();
  // Without an address the app had no network, which is the cause rather than the app itself.
  const noNet = !job.ip && job.opt.ip === 'dhcp'
    ? ` The container got no network address: Proxmox's DHCP for it did not work${warnings.size ? ' (' + [...warnings].join('; ') + ')' : ''}.`
      + ' Update Proxmox (apt update && apt full-upgrade on the host), or install again with a static IP address under Advanced options.'
    : '';
  if (noNet) job.detail = [...warnings, job.detail].filter(Boolean).join('\n') || job.detail;
  if (failed) throw new Error((failed === 'stopped' ? 'The container was created, but the app in it stopped right after starting.' : failed) + noNet
    + (job.detail ? ' The last lines it printed are shown below.' : noNet ? '' : ' This image may not work as a Proxmox container. Set up the file browser to see what the app prints when this happens.'));
  // A few seconds more: an app that cannot run at all has usually given up by now.
  await sleep(6000);
  if ((await pve('GET', base + '/status/current')).status !== 'running') {
    if (wrap) job.detail = await startOutput(job.vmid, base, own).catch(() => null);
    await halt().catch(() => {}); if (wrap) await pve('PUT', base + '/config', { entrypoint: waitNet(own) }).catch(() => {});
    throw new Error('The container was created, but the app in it stopped a few seconds after starting.' + (job.detail ? ' The last lines it printed are shown below.' : ''));
  }
  // Apps without a web UI (port 0) get no Open link.
  if (job.ip && job.port) job.url = appUrl(job.ip, job);
}
// What an app prints when it starts, for an app that stops by itself. The container is started with its output
// going to a file and is kept alive for a while, and the file is read through the file helper. Returns the last
// lines, or null when that is not possible (no file browser, or an image without a shell).
async function startOutput(vmid, base, entrypoint) {
  if (!fs.existsSync(path.join(DATA, 'files_key'))) return null;
  await pve('PUT', base + '/config', { entrypoint: capture(entrypoint) });
  await waitTask(await pve('POST', base + '/status/start'), 3 * 60 * 1000);
  await sleep(25000);
  return summary((await helper({ op: 'read', vmid, path: LOG, max: 5e6 })).toString('utf8'));
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

// ---------- shortcuts (saved links with notes) ----------
const SHORTCUTS_FILE = path.join(DATA, 'shortcuts.json');
let shortcuts = readJson(SHORTCUTS_FILE, []);   // [{ id, name, url, notes }]
function saveShortcut(b) {
  let url = String(b.url || '').trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  let u; try { u = new URL(url); } catch { throw new Error('Enter a link, for example google.com'); }
  if (!/^https?:$/.test(u.protocol) || u.href.length > 2000) throw new Error('Links must start with http:// or https://');
  const s = { id: b.id, name: String(b.name || '').trim().slice(0, 80) || u.hostname.replace(/^www\./, ''), url: u.href, notes: String(b.notes || '').trim().slice(0, 4000) };
  if (b.id) {
    const i = shortcuts.findIndex(x => x.id === b.id);
    if (i < 0) throw new Error('Shortcut not found');
    shortcuts[i] = s;
  } else {
    if (shortcuts.length >= 500) throw new Error('Too many shortcuts');
    s.id = crypto.randomBytes(6).toString('hex'); shortcuts.push(s);
  }
  writeJson(SHORTCUTS_FILE, shortcuts);
  return s;
}
function deleteShortcut(id) { shortcuts = shortcuts.filter(x => x.id !== id); writeJson(SHORTCUTS_FILE, shortcuts); }

// ---------- file browser ----------
// The Proxmox API cannot read files in a container, so this goes over SSH to host/appstore-files on the
// Proxmox host, with a key that can only run that helper. See "File browser" in the README.
const { spawn, execFile } = require('child_process');
const FILES_KEY = path.join(DATA, 'files_key');
const HELPER_SRC = (() => { try { return fs.readFileSync(path.join(__dirname, 'host', 'appstore-files'), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } })();
const HELPER_VERSION = Number((/^my \$VERSION = (\d+);/m.exec(HELPER_SRC) || [])[1]) || 0;
const MAX_EDIT = 1024 * 1024;   // largest file the editor opens or saves
const HELPER_ERRORS = {
  NOTRUNNING: 'Start the app to browse its files.',
  PRIVILEGED: 'The file browser only works with unprivileged containers.',
  TOOLARGE: 'This file is too large to open here. Download it instead.',
  NOTFILE: 'This is not a regular file.',
  NOFILE: 'This file does not exist yet.',
  'Unknown request': 'The helper on the Proxmox host is an older version. Open the Files tab and run the setup command again to update it.',
};
const MAX_UPLOAD = 64 * 1024 * 1024;   // largest file the Upload button and the plugin installer send to a container
// Sends one request to the helper. `input` is the file content for a write. With `onData`, the answer is
// streamed to it; otherwise it is collected and returned as a Buffer.
function helper(req, { input, onData, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const host = config.pve.host;
    if (!/^[A-Za-z0-9]/.test(host)) return reject(new Error('Invalid Proxmox host name'));
    // Development only: FILES_HELPER_CMD runs the helper as a local command instead of over SSH.
    const dev = process.env.FILES_HELPER_CMD && process.env.FILES_HELPER_CMD.split(' ');
    const p = dev ? spawn(dev[0], dev.slice(1)) : spawn('ssh', ['-F', '/dev/null', '-i', FILES_KEY, '-T',
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(DATA, 'known_hosts'),
      'root@' + host, 'appstore-files']);
    const out = []; let size = 0, err = '', settled = false;
    const timer = setTimeout(() => { p.kill(); finish(new Error('The Proxmox host took too long to answer')); }, timeout);
    const finish = (e, v) => { if (settled) return; settled = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
    p.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'ssh is not installed in the App Store container. Run this in its console: apt install -y openssh-client' : e.message)));
    p.stdin.on('error', () => {});
    p.stdout.on('data', c => { if (onData) return onData(c); size += c.length; if (size > 8e6) { p.kill(); return finish(new Error('The answer from the host is too large')); } out.push(c); });
    p.stderr.on('data', c => { if (err.length < 4000) err += c; });
    p.on('close', code => {
      if (code === 0) return finish(null, Buffer.concat(out));
      const m = /^ERR: (.*)$/m.exec(err);
      if (m) return finish(new Error(HELPER_ERRORS[m[1]] || m[1]));
      const e = new Error('Cannot reach the file helper on the Proxmox host' + (err.trim() ? ': ' + err.trim().split('\n').pop().slice(0, 200) : '')); e.setup = true; finish(e);
    });
    p.stdin.end(Buffer.concat([Buffer.from(JSON.stringify(req) + '\n'), input || Buffer.alloc(0)]));
  });
}
// What to paste in the host's shell: installs the helper and allows this App Store's key to run it, and nothing else.
function filesSetupCommand(pub) {
  const line = `command="/usr/local/bin/appstore-files",restrict ${pub}`;
  return `cat > /usr/local/bin/appstore-files <<'APPSTORE_FILES_EOF'\n${HELPER_SRC.trimEnd()}\nAPPSTORE_FILES_EOF\n`
    + `chmod 755 /usr/local/bin/appstore-files\nmkdir -p /root/.ssh\n`
    + `grep -qF '${pub.split(' ')[1]}' /root/.ssh/authorized_keys 2>/dev/null || echo '${line}' >> /root/.ssh/authorized_keys\n`
    + `echo "File browser helper installed."\n`;
}
async function filesStatus() {
  if (!HELPER_SRC) return { connected: false, error: 'host/appstore-files is missing from this installation.' };
  if (!fs.existsSync(FILES_KEY + '.pub')) {
    try { await new Promise((res, rej) => execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'appstore-files', '-f', FILES_KEY], e => e ? rej(e) : res())); }
    catch (e) { return { connected: false, error: e.code === 'ENOENT' ? 'ssh is not installed in the App Store container. Run this in its console, then reload: apt install -y openssh-client' : 'Could not create an SSH key: ' + e.message }; }
  }
  const pub = fs.readFileSync(FILES_KEY + '.pub', 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [\w.@-]+)?$/.test(pub)) return { connected: false, error: 'The SSH key in the data folder is not valid. Delete files_key and files_key.pub there and reload.' };
  try {
    const v = JSON.parse(await helper({ op: 'version' })).version;
    if (v >= HELPER_VERSION) return { connected: true };
    return { connected: false, command: filesSetupCommand(pub), error: 'The helper on the Proxmox host is an older version. Run the command again to update it.' };
  } catch (e) { return { connected: false, command: filesSetupCommand(pub), error: e.message }; }
}
const filePath = p => {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.length > 4096) throw new Error('Bad path');
  return path.posix.normalize(p);
};
const fileName = n => { if (typeof n !== 'string' || !n || n === '.' || n === '..' || /[/\0]/.test(n) || n.length > 255) throw new Error('A name cannot be empty or contain "/"'); return n; };
// Only containers this App Store lists, and never its own.
async function filesGuest(vmid) {
  const g = (await listGuests()).guests.find(x => String(x.vmid) === vmid && x.type === 'lxc');
  if (!g) throw new Error('Guest not found');
  if (g.self) throw new Error('This is the App Store itself - manage it from the Proxmox UI.');
  return Number(vmid);
}
async function filesList(vmid, p) {
  const r = JSON.parse(await helper({ op: 'list', vmid, path: p }));
  r.entries.sort((a, b) => ((a.type === 'd' || a.target === 'd') ? 0 : 1) - ((b.type === 'd' || b.target === 'd') ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: p, ...r };
}
async function filesRead(vmid, p) {
  const buf = await helper({ op: 'read', vmid, path: p, max: MAX_EDIT });
  const text = buf.toString('utf8');
  // Only text that survives the round trip unchanged may be edited; anything else would be damaged by saving.
  if (buf.includes(0) || !Buffer.from(text, 'utf8').equals(buf)) return { path: p, binary: true };
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
  return { path: p, text: crlf ? text.replace(/\r\n/g, '\n') : text, crlf };
}
async function filesChange(vmid, b) {
  // write, rename and delete name an existing `path`; create and mkdir name a new `name` inside `dir`.
  const p = ['write', 'rename', 'delete'].includes(b.op) ? filePath(b.path) : null, join = n => path.posix.join(filePath(b.dir), fileName(n));
  const write = (to, create) => {
    let text = String(b.text ?? ''); if (b.crlf) text = text.replace(/\r?\n/g, '\r\n');
    const input = Buffer.from(text, 'utf8');
    if (input.length > MAX_EDIT) throw new Error('This file is too large to save here (the limit is 1 MB).');
    return helper({ op: 'write', vmid, path: to, size: input.length, create }, { input });
  };
  if (b.op === 'write') await write(p, false);
  else if (b.op === 'create') await write(join(b.name), true);
  else if (b.op === 'mkdir') await helper({ op: 'mkdir', vmid, path: join(b.name) });
  else if (b.op === 'rename') await helper({ op: 'rename', vmid, path: p, to: path.posix.join(path.posix.dirname(p), fileName(b.name)) });
  else if (b.op === 'delete') { if (p === '/') throw new Error('The top folder cannot be deleted'); await helper({ op: 'delete', vmid, path: p }); }
  else throw new Error('Unknown action');
  return { ok: true };
}
// Streams a file to the browser. Waits for the first data before answering, so a failure can still be reported.
function filesDownload(vmid, p, res) {
  let started = false;
  const start = () => { if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p) || 'file')}` }); } };
  return helper({ op: 'read', vmid, path: p }, { onData: c => { start(); res.write(c); }, timeout: 10 * 60 * 1000 })
    .then(() => { start(); res.end(); }, e => { if (started) res.destroy(); else throw e; });
}
// Saves an uploaded file in a folder of the container. `replace` allows writing over a file with the same name.
async function filesUpload(vmid, dir, name, input, replace) {
  await helper({ op: 'write', vmid, path: path.posix.join(filePath(dir), fileName(name)), size: input.length, create: true, replace: !!replace }, { input, timeout: 5 * 60 * 1000 });
  return { ok: true };
}

// ---------- game servers ----------
// Apps marked "game" in the catalog get a console, a player list and a plugin manager on the Manage page.
// The console reads the server's log through the file helper. Commands and the player list go over the game's
// own remote console (RCON), straight from here to the container, so the helper never has to run anything.
const net = require('net');
const GAMES = {
  minecraft: { data: '/data', log: '/data/logs/latest.log', props: '/data/server.properties', ops: '/data/ops.json' },
};
const STARTING = 'The server is still starting. Commands and the player list work once it is ready.';
function gameOf(vmid) {
  const a = apps[vmid], c = a && catalog.find(x => x.id === a.appId), G = c && GAMES[c.game];
  if (!G) throw new Error('This app is not a game server');
  return G;
}
// New lines of the log since `pos` (null: the end of the log). Only whole lines are returned, so a line that is
// still being written, or a character cut in half, waits for the next call.
async function gameLog(vmid, G, pos, max) {
  const req = { op: 'tail', vmid, path: G.log, max };
  if (pos != null) req.offset = pos;
  let buf;
  try { buf = await helper(req); }
  catch (e) { if (/does not exist yet/.test(e.message)) return { pos: 0, text: '', reset: pos != null && pos !== 0 }; throw e; }
  const nl = buf.indexOf(10), start = Number(buf.subarray(0, nl).toString().split(' ')[0]);
  if (nl < 0 || !Number.isInteger(start)) throw new Error('Unexpected answer from the file helper');
  let body = buf.subarray(nl + 1), from = start;
  if (pos == null && start > 0) { const i = body.indexOf(10) + 1; from += i; body = body.subarray(i); }   // begins in the middle of a line
  const end = body.lastIndexOf(10), take = end >= 0 ? end + 1 : body.length >= max ? body.length : 0;
  return { pos: from + take, text: body.subarray(0, take).toString('utf8'), reset: pos != null && start !== pos };
}

// ----- RCON: one open connection per server, closed after two minutes without use -----
const rcons = new Map(), rconQueue = new Map();
const rconPacket = (id, type, body) => { const b = Buffer.from(body, 'utf8'), p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p; };
function rconConnect(host, port, password) {
  const sock = net.connect({ host, port });
  let buf = Buffer.alloc(0), cur = null, dead = null, seq = 0, idle;
  const close = e => {
    if (dead) return;
    dead = e || new Error('The connection to the server was closed');
    clearTimeout(idle); sock.destroy();
    if (cur) { clearTimeout(cur.timer); cur.reject(dead); cur = null; }
  };
  // A long answer arrives in several packets. To know where it ends, every command is followed by a request the
  // server does not know: it answers those in order too, so that answer marks the end.
  const ask = (type, body) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = seq += 2;
    cur = { id, type, out: '', resolve, reject, timer: setTimeout(() => close(new Error('The server did not answer in time')), 8000) };
    sock.write(rconPacket(id, type, body));
    if (type === 2) sock.write(rconPacket(id + 1, 100, ''));
  });
  const done = v => { const c = cur; cur = null; clearTimeout(c.timer); c.resolve(v); };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readInt32LE(0);
      if (len < 10 || len > 1e6) return close(new Error('Unexpected answer from the server'));
      if (buf.length < 4 + len) break;
      const id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString('utf8', 12, 2 + len);
      buf = buf.subarray(4 + len);
      if (!cur) continue;
      if (cur.type === 3) { if (type === 2) { if (id === -1) close(new Error('The server did not accept the remote console password')); else done(); } }
      else if (id === cur.id) cur.out += body;
      else if (id === cur.id + 1) done(cur.out);
    }
  });
  sock.on('error', e => close(new Error(e.code === 'ECONNREFUSED' ? STARTING : 'Cannot reach the server: ' + e.message)));
  sock.on('close', () => close());
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => close(), 120000); };
  return { dead: () => !!dead, close: () => close(), login: () => ask(3, password), command: c => { touch(); return ask(2, c); } };
}
// Runs one command on the server and returns what it answers. Commands for the same server run one at a time.
function rcon(vmid, cmd) {
  const run = async () => {
    let c = rcons.get(vmid);
    if (!c || c.dead()) {
      const g = (await listGuests()).guests.find(x => x.vmid === vmid && x.type === 'lxc');
      if (!g || g.status !== 'running') throw new Error('The server is not running.');
      if (!g.ip) throw new Error(STARTING);
      // The port and password are in the server's own settings file. The image writes a new password there when none is set.
      let text;
      try { text = (await helper({ op: 'read', vmid, path: gameOf(vmid).props, max: 2e5 })).toString('utf8'); }
      catch (e) { throw /No such file/.test(e.message) ? new Error(STARTING) : e; }
      const props = Object.fromEntries(text.split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).replace(/\\(.)/g, '$1')]; }));
      if (props['enable-rcon'] !== 'true' || !props['rcon.password']) throw new Error('The remote console (RCON) is turned off for this server, so commands and the player list are not available. Remove ENABLE_RCON under Settings and restart to turn it on.');
      c = rconConnect(g.ip, Number(props['rcon.port']) || 25575, props['rcon.password']);
      try { await c.login(); } catch (e) { c.close(); throw e; }
      rcons.set(vmid, c);
    }
    return (await c.command(cmd)).replace(/§./g, '');
  };
  const q = (rconQueue.get(vmid) || Promise.resolve()).then(run, run);
  rconQueue.set(vmid, q.catch(() => {}));
  return q;
}
// Who is online, from the "list" command: "There are 2 of a max of 20 players online: Alex, Steve".
async function gamePlayers(vmid) {
  const lines = (await rcon(vmid, 'list')).split('\n'), nums = (lines[0] || '').match(/\d+/g) || [];
  const names = lines.flatMap(l => { const i = l.indexOf(':'); return i < 0 ? [] : l.slice(i + 1).split(','); }).map(s => s.trim()).filter(n => /^[\w.*-]{1,32}$/.test(n));
  const ops = await cached('ops' + vmid, 15000, async () => JSON.parse((await helper({ op: 'read', vmid, path: gameOf(vmid).ops, max: 1e6 })).toString('utf8')).map(o => String(o.name))) || [];
  return { online: nums.length ? Number(nums[0]) : names.length, max: Number(nums[1]) || 0, players: names.map(name => ({ name, op: ops.includes(name) })), ops };
}

// ----- plugins and mods -----
// Which Modrinth loaders fit each server type. Types that are not listed (Vanilla, modpack installers) take neither.
const MC_LOADERS = {
  PAPER: ['paper', 'spigot', 'bukkit'], PURPUR: ['purpur', 'paper', 'spigot', 'bukkit'], PUFFERFISH: ['paper', 'spigot', 'bukkit'],
  SPIGOT: ['spigot', 'bukkit'], BUKKIT: ['bukkit'], FOLIA: ['folia'],
  FABRIC: ['fabric'], QUILT: ['quilt', 'fabric'], FORGE: ['forge'], NEOFORGE: ['neoforge'],
};
const MC_MODS = ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'];
const MODRINTH = 'https://api.modrinth.com/v2';
const getBuf = (url, max, timeout = 20000) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { 'User-Agent': 'proxmox-appstore' }, timeout }, res => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('Modrinth answered HTTP ' + res.statusCode)); }
    const parts = []; let n = 0;
    res.on('data', c => { n += c.length; if (n > max) return req.destroy(new Error('The download is too large')); parts.push(c); });
    res.on('end', () => resolve(Buffer.concat(parts)));
  });
  req.on('timeout', () => req.destroy(new Error('Modrinth took too long to answer'))); req.on('error', e => reject(new Error(/Modrinth|download/.test(e.message) ? e.message : 'Cannot reach Modrinth: ' + e.message)));
});
async function gameInfo(vmid) {
  const G = gameOf(vmid), env = new Map(parseEnv((await pve('GET', `${node()}/lxc/${vmid}/config`)).env));
  const type = String(env.get('TYPE') || 'VANILLA').toUpperCase(), loaders = MC_LOADERS[type] || null, mods = MC_MODS.includes(type);
  // The Minecraft version is on one of the first lines the server logs.
  const version = await cached('mcver' + vmid, 30000, async () => {
    const m = /Starting minecraft server version ([\w.-]+)/.exec((await gameLog(vmid, G, 0, 30000)).text);
    if (!m) throw new Error('unknown'); return m[1];
  });
  return { type, loaders, kind: loaders ? (mods ? 'mod' : 'plugin') : null, dir: G.data + (mods ? '/mods' : '/plugins'), version };
}
async function gamePlugins(vmid) {
  const info = await gameInfo(vmid);
  if (!info.kind) return { ...info, items: [] };
  let entries = [];
  try { entries = JSON.parse(await helper({ op: 'list', vmid, path: info.dir })).entries; } catch (e) { if (!/No such file/.test(e.message)) throw e; }
  // A plugin keeps its settings in a folder named after it, next to the .jar file.
  const dirs = entries.filter(e => e.type === 'd').map(e => e.name);
  const items = entries.filter(e => e.type === 'f' && /\.jar(\.disabled)?$/i.test(e.name)).map(e => {
    const name = e.name.replace(/\.jar(\.disabled)?$/i, ''), low = name.toLowerCase();
    const cfg = info.kind === 'plugin' && dirs.filter(d => low.startsWith(d.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    return { file: e.name, name, size: e.size, mtime: e.mtime, enabled: /\.jar$/i.test(e.name), config: cfg ? info.dir + '/' + cfg : null };
  }).sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  return { ...info, items };
}
async function gameSearch(vmid, q) {
  const info = await gameInfo(vmid);
  if (!info.kind) return { hits: [] };
  const facets = [[`project_type:${info.kind}`], info.loaders.map(l => 'categories:' + l)];
  if (info.kind === 'mod') facets.push(['server_side:required', 'server_side:optional']);
  if (info.version) facets.push(['versions:' + info.version]);
  const r = JSON.parse(await getBuf(`${MODRINTH}/search?${new URLSearchParams({ query: String(q || '').slice(0, 100), limit: 12, facets: JSON.stringify(facets) })}`, 5e6));
  return { hits: (r.hits || []).map(h => ({ id: h.project_id, title: h.title, desc: h.description, downloads: h.downloads, icon: /^https:\/\/cdn\.modrinth\.com\//.test(h.icon_url || '') ? h.icon_url : null })) };
}
// Enable or disable (a disabled plugin is renamed to .jar.disabled, which the server skips), delete, or install from Modrinth.
async function gamePluginChange(vmid, b) {
  const info = await gameInfo(vmid);
  if (!info.kind) throw new Error('This server type cannot load plugins or mods.');
  if (b.op === 'install') {
    if (!/^[A-Za-z0-9]{6,12}$/.test(b.id || '')) throw new Error('Bad request');
    const qs = { loaders: JSON.stringify(info.loaders) };
    if (info.version) qs.game_versions = JSON.stringify([info.version]);
    const versions = JSON.parse(await getBuf(`${MODRINTH}/project/${b.id}/version?${new URLSearchParams(qs)}`, 3e7));
    const jar = v => (v.files || []).find(f => f.primary && /\.jar$/i.test(f.filename)) || (v.files || []).find(f => /\.jar$/i.test(f.filename));
    const v = versions.find(x => x.version_type === 'release' && jar(x)) || versions.find(jar);
    if (!v) throw new Error(`No version of this ${info.kind} fits this server (${info.type}${info.version ? ' ' + info.version : ''}).`);
    const f = jar(v), name = fileName(f.filename);
    if (!/^https:\/\/cdn\.modrinth\.com\//.test(f.url) || !(f.size <= MAX_UPLOAD)) throw new Error('This file cannot be installed from here. Download it and use Upload instead.');
    const data = await getBuf(f.url, MAX_UPLOAD, 2 * 60 * 1000);
    if (crypto.createHash('sha512').update(data).digest('hex') !== (f.hashes || {}).sha512) throw new Error('The download was damaged on the way. Try again.');
    await helper({ op: 'mkdir', vmid, path: info.dir }).catch(() => {});   // already there on every server that has started once
    await filesUpload(vmid, info.dir, name, data, true);
    return { ok: true, file: name, version: v.version_number, needs: (v.dependencies || []).filter(d => d.dependency_type === 'required').length };
  }
  const file = fileName(b.file), p = info.dir + '/' + file;
  if (!/\.jar(\.disabled)?$/i.test(file)) throw new Error('This is not a plugin file');
  if (b.op === 'delete') await helper({ op: 'delete', vmid, path: p });
  else if (b.op === 'toggle') await helper({ op: 'rename', vmid, path: p, to: /\.disabled$/i.test(file) ? p.replace(/\.disabled$/i, '') : p + '.disabled' });
  else throw new Error('Unknown action');
  return { ok: true };
}

// ---------- update check ----------
// Compares the commit this process was started from with the newest one on GitHub.
const GIT_DIR = path.join(__dirname, '.git');
const RUNNING = (() => {
  try {
    const head = fs.readFileSync(path.join(GIT_DIR, 'HEAD'), 'utf8').trim(), m = /^ref: (.+)$/.exec(head);
    if (!m) return head;
    try { return fs.readFileSync(path.join(GIT_DIR, m[1]), 'utf8').trim(); }
    catch { const l = fs.readFileSync(path.join(GIT_DIR, 'packed-refs'), 'utf8').split('\n').find(x => x.endsWith(' ' + m[1])); return l ? l.split(' ')[0] : null; }
  } catch { return null; }
})();
const REPO = (() => {
  try { const m = /^\s*url\s*=.*github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(fs.readFileSync(path.join(GIT_DIR, 'config'), 'utf8')); return m ? m[1] : null; }
  catch { return null; }
})();
const getText = (url, headers = {}) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { 'User-Agent': 'proxmox-appstore', ...headers }, timeout: 10000 }, res => {
    let d = ''; res.on('data', c => { d += c; if (d.length > 2e6) req.destroy(new Error('Response too large')); });
    res.on('end', () => res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode)));
  });
  req.on('timeout', () => req.destroy(new Error('Timed out'))); req.on('error', reject);
});
const update = { t: 0, v: { available: false } };
async function updateInfo() {
  if (RUNNING && REPO && Date.now() - update.t > 15 * 60 * 1000) {
    update.t = Date.now();
    try {
      const sha = (await getText(`https://api.github.com/repos/${REPO}/commits/main`, { Accept: 'application/vnd.github.sha' })).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Unexpected answer');
      let releases = [];
      if (sha !== RUNNING) {
        // What is new: the versions in the changelog on GitHub that this copy does not have.
        try {
          const have = new Set(readJson(path.join(__dirname, 'changelog.json'), []).map(r => r.version));
          releases = JSON.parse(await getText(`https://raw.githubusercontent.com/${REPO}/${sha}/changelog.json`)).filter(r => !have.has(r.version)).slice(0, 5);
        } catch {}
      }
      update.v = { available: sha !== RUNNING, latest: sha.slice(0, 7), releases };
    } catch {}   // GitHub unreachable or a private repository: keep the last answer
  }
  // How an update gets installed here depends on which systemd units are enabled in this container.
  const enabled = n => fs.existsSync('/etc/systemd/system/' + n);
  const mode = enabled('paths.target.wants/appstore-update.path') ? 'button' : enabled('timers.target.wants/appstore-update.timer') ? 'auto' : 'manual';
  return { ...update.v, running: RUNNING ? RUNNING.slice(0, 7) : null, mode };
}

// ---------- setup / auth ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
// install.sh leaves the Proxmox address and API token here, so the setup page only has to ask for a password.
const PRESEED_FILE = path.join(DATA, 'preseed.json');
const preseed = () => { const p = readJson(PRESEED_FILE, null); return p && p.host && p.tokenId && p.secret ? p : null; };
async function setup(b) {
  if (config) throw new Error('Already configured');
  const pre = preseed();
  if (pre) b = { password: b.password, host: pre.host, tokenId: pre.tokenId, secret: pre.secret };
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
  fs.rmSync(PRESEED_FILE, { force: true });
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
const readBody = (req, max = 1e5) => new Promise((resolve, reject) => {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('Expected JSON'));
  let d = ''; req.on('data', c => { d += c; if (d.length > max) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});
// The body of an upload. A file that is too large is read to the end and then refused, so the browser gets the answer.
const readRaw = (req, max) => new Promise((resolve, reject) => {
  if (!/^application\/octet-stream/.test(req.headers['content-type'] || '')) return reject(new Error('Expected a file'));
  const parts = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > max) parts.length = 0; else parts.push(c); });
  req.on('end', () => n > max ? reject(new Error('This file is too large to upload here (the limit is 64 MB).')) : resolve(Buffer.concat(parts)));
  req.on('error', reject);
});

async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (p === '/api/state') return send(res, 200, { configured: !!config, authed: authed(req), dev: !!DEV, preseeded: !config && !!preseed() });
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
  if (p === '/api/catalog' && M === 'GET') return send(res, 200, catalogView);
  if (p === '/api/jobs' && M === 'GET') return send(res, 200, jobs);
  if (p === '/api/changelog' && M === 'GET') return send(res, 200, readJson(path.join(__dirname, 'changelog.json'), []));
  if (p === '/api/update' && M === 'GET') return send(res, 200, await updateInfo());
  if (p === '/api/update' && M === 'POST') {
    // The appstore-update.path unit (run by root) sees this file and installs the update.
    await readBody(req);
    const u = await updateInfo();
    if (u.mode === 'button') fs.writeFileSync(path.join(DATA, 'update-request'), '');
    return send(res, 200, u);
  }
  if (p === '/api/files/status' && M === 'GET') return send(res, 200, await filesStatus());
  const f = /^\/api\/guests\/lxc\/(\d+)\/(files|file|download|upload)$/.exec(p);
  if (f) {
    const vmid = await filesGuest(f[1]);
    if (f[2] === 'upload') {
      if (M !== 'POST') return send(res, 404, { error: 'Not found' });
      const q = url.searchParams;
      return send(res, 200, await filesUpload(vmid, q.get('dir'), q.get('name'), await readRaw(req, MAX_UPLOAD), q.get('replace') === '1'));
    }
    if (f[2] === 'files' && M === 'POST') return send(res, 200, await filesChange(vmid, await readBody(req, 8e6)));
    if (M !== 'GET') return send(res, 404, { error: 'Not found' });
    const fp = filePath(url.searchParams.get('path'));
    if (f[2] === 'files') return send(res, 200, await filesList(vmid, fp));
    if (f[2] === 'file') return send(res, 200, await filesRead(vmid, fp));
    return filesDownload(vmid, fp, res);
  }
  const gm = /^\/api\/guests\/lxc\/(\d+)\/game\/(log|command|players|plugins|search)$/.exec(p);
  if (gm) {
    const vmid = await filesGuest(gm[1]), G = gameOf(vmid), what = gm[2], q = url.searchParams;
    if (what === 'log' && M === 'GET') {
      const pos = q.get('pos');
      if (pos !== null && !/^\d{1,15}$/.test(pos)) throw new Error('Bad request');
      return send(res, 200, await gameLog(vmid, G, pos === null ? null : Number(pos), pos === null ? 60000 : 200000));
    }
    if (what === 'command' && M === 'POST') {
      const cmd = String((await readBody(req)).command || '').trim().replace(/^\//, '');
      if (!cmd || cmd.length > 1000 || /[\x00-\x1f\x7f]/.test(cmd)) throw new Error('Enter a command on one line');
      const output = await rcon(vmid, cmd);
      cache.delete('ops' + vmid);   // the command may have been "op" or "deop"
      return send(res, 200, { output });
    }
    if (what === 'players' && M === 'GET') return send(res, 200, await gamePlayers(vmid));
    if (what === 'plugins' && M === 'GET') return send(res, 200, await gamePlugins(vmid));
    if (what === 'plugins' && M === 'POST') return send(res, 200, await gamePluginChange(vmid, await readBody(req)));
    if (what === 'search' && M === 'GET') return send(res, 200, await gameSearch(vmid, q.get('q')));
    return send(res, 404, { error: 'Not found' });
  }
  if (p === '/api/shortcuts' && M === 'GET') return send(res, 200, shortcuts);
  if (p === '/api/shortcuts' && M === 'POST') return send(res, 200, saveShortcut(await readBody(req)));
  const sd = /^\/api\/shortcuts\/([a-f0-9]{12})\/delete$/.exec(p);
  if (sd && M === 'POST') { await readBody(req); deleteShortcut(sd[1]); return send(res, 200, { ok: true }); }
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
