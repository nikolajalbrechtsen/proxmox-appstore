'use strict';
// Compatibility test: proves that the apps in catalog.json work as Proxmox containers.
// For each app it does what the store does (download the image, create the container, apply the settings,
// start it), then checks that the container stays running and that its web page answers, and deletes it again.
//
// Run it in the App Store container, from /opt/appstore:
//   node tools/compat.js                 test every app that has no result yet
//   node tools/compat.js --only a,b      test these apps (again)
//   node tools/compat.js --retest        test everything again
//   node tools/compat.js --failed        test the apps that failed last time again
//   node tools/compat.js --jobs 3        how many apps to test at the same time (default 3)
//   node tools/compat.js --memory 2048   how much memory (MB) the apps under test may be given together
//   node tools/compat.js --keep          leave a failed container in place, stopped, to look at
// Results are written to compat-results.json in the data folder after every app. Copy that file to compat.json
// in the repository: the store reads it to hide the apps that fail and to mark the ones nobody has tested.
//
//   node tools/compat.js --check         no testing: lists the catalog apps without a passing result in compat.json
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { waitNet, wrappable, capture, summary, LOG } = require('../entrypoint');

const args = process.argv.slice(2), flag = n => args.includes('--' + n), opt = n => { const i = args.indexOf('--' + n); return i < 0 ? null : args[i + 1]; };
const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(opt('catalog') || path.join(ROOT, 'catalog.json'), 'utf8'));
if (flag('check')) {
  const c = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'compat.json'), 'utf8')); } catch { return {}; } })();
  const bad = catalog.filter(a => !(c[a.id] && c[a.id].ok && c[a.id].image === normImage(a.image)));
  for (const a of bad) console.log(`${a.id}: ${!c[a.id] ? 'not tested' : c[a.id].ok ? 'tested with another image (' + c[a.id].image + ')' : 'fails - ' + c[a.id].error}`);
  console.log(`${catalog.length - bad.length} of ${catalog.length} apps have passed the test.`);
  process.exit(bad.some(a => !c[a.id] || c[a.id].ok) ? 1 : 0);   // apps that fail are hidden by the store; untested ones are the problem
}
const DATA = process.env.DATA_DIR || (fs.existsSync('/var/lib/appstore/config.json') ? '/var/lib/appstore' : path.join(ROOT, 'data'));
const OUT = opt('out') || path.join(DATA, 'compat-results.json');
const P = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).pve;
const results = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return {}; } })();
const save = () => { fs.writeFileSync(OUT + '.tmp', JSON.stringify(results, null, 1)); fs.renameSync(OUT + '.tmp', OUT); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const node = '/nodes/' + P.node;
const FIRST_ID = Number(opt('first-id')) || 9000;   // test containers get IDs from here on, far from real ones

function pve(method, p, params) {
  return new Promise((resolve, reject) => {
    const hasBody = params && method !== 'GET' && method !== 'DELETE', qs = params ? new URLSearchParams(params).toString() : '';
    const headers = { Authorization: `PVEAPIToken=${P.tokenId}=${P.secret}` };
    if (hasBody) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(qs); }
    const req = https.request({ host: P.host, port: P.port || 8006, method, headers, timeout: 30000, path: '/api2/json' + p + (!hasBody && qs ? '?' + qs : ''), rejectUnauthorized: false }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j ? j.data : null);
        reject(new Error(String((j && j.message) || res.statusMessage || 'HTTP ' + res.statusCode).replace(/\s+/g, ' ').trim() + (j && j.errors ? ' ' + JSON.stringify(j.errors) : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox API timed out'))); req.on('error', reject);
    if (hasBody) req.write(qs);
    req.end();
  });
}
// Waits for a Proxmox task. Returns its log lines; throws when it failed (warnings are not a failure).
async function waitTask(upid, ms = 20 * 60 * 1000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1500)) {
    const s = await pve('GET', `${node}/tasks/${encodeURIComponent(upid)}/status`);
    if (s.status !== 'stopped') continue;
    const log = (await pve('GET', `${node}/tasks/${encodeURIComponent(upid)}/log`, { start: 0, limit: 500 }).catch(() => [])).map(l => l.t).filter(t => !/^TASK/.test(t));
    if (s.exitstatus === 'OK' || /^WARNINGS/.test(s.exitstatus || '')) return log;
    throw new Error(`${s.exitstatus}${log.length ? ' - ' + log.slice(-3).join(' | ') : ''}`);
  }
  throw new Error('Task timed out');
}
function normImage(ref) {
  ref = String(ref).trim().toLowerCase();
  const parts = ref.split('/');
  if (!/[.:]/.test(parts[0]) || parts.length === 1) ref = 'docker.io/' + (parts.length === 1 ? 'library/' : '') + ref;
  if (!/:[\w.-]+$/.test(ref.split('/').pop())) ref += ':latest';
  return ref;
}
const fill = s => String(s ?? '').replace(/\{\{hex(\d+)\}\}/g, (_, n) => crypto.randomBytes(n / 2).toString('hex'));
const firstIp = list => {
  for (const i of list || []) {
    if (i.name === 'lo') continue;
    for (const a of i['ip-addresses'] || []) if (/^(ipv4|inet)$/.test(a['ip-address-type']) && !a['ip-address'].startsWith('127.')) return a['ip-address'];
  }
  return null;
};
// True when anything that speaks HTTP answers on the app's port. The status does not matter: a login page,
// a redirect or "unauthorized" all show that the app is up.
const answers = (ip, app) => new Promise(resolve => {
  const req = (app.https ? https : http).get({ host: ip, port: app.port, path: app.path || '/', timeout: 5000, rejectUnauthorized: false }, res => { res.resume(); resolve(res.statusCode); });
  req.on('timeout', () => req.destroy()); req.on('error', () => resolve(0));
});
// Reads a file in a running container through the file helper on the host. Null when the file browser is not set up.
const readFile = (vmid, file) => new Promise(resolve => {
  const p = spawn('ssh', ['-F', '/dev/null', '-i', path.join(DATA, 'files_key'), '-T', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
    '-o', 'UserKnownHostsFile=' + path.join(DATA, 'known_hosts'), 'root@' + P.host, 'appstore-files']);
  let out = ''; p.stdout.on('data', c => out += c); p.on('error', () => resolve(null)); p.on('close', code => resolve(code === 0 ? out : null));
  p.stdin.on('error', () => {}); p.stdin.end(JSON.stringify({ op: 'read', vmid, path: file }) + '\n');
});

let rateLimited = 0;
// Installs, checks and deletes one app, the way the store's installer does it: with the wait-for-network
// wrapper when the image can run it, and with the image's own start command when that does not start.
async function testApp(app, vmid) {
  const image = normImage(app.image), file = 'compat-' + image.replace(/^docker\.io\/(library\/)?/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const tmplDir = `${node}/storage/${P.tmplStorage}`, base = `${node}/lxc/${vmid}`, r = { ok: false, image };
  const findTmpl = async () => (await pve('GET', tmplDir + '/content', { content: 'vztmpl' })).find(c => c.volid.endsWith(`/${file}.tar`));
  const halt = async () => { if ((await pve('GET', base + '/status/current')).status !== 'stopped') await waitTask(await pve('POST', base + '/status/stop'), 60000).catch(() => {}); };
  let created = false, stage = 'download', t0 = Date.now(), tmpl;
  try {
    tmpl = await findTmpl();
    if (!tmpl) {
      while (Date.now() < rateLimited) await sleep(5000);
      // Never fill the host's disk: with less than 15 GB free for images, wait until there is room again.
      for (let told = false; ; await sleep(60000)) {
        const st = await pve('GET', `${tmplDir}/status`).catch(() => null);
        if (!st || st.avail > 15 * 1024 ** 3) break;
        if (!told) { told = true; console.log(`[wait] ${app.id}: less than 15 GB free on storage ${P.tmplStorage}, waiting for room`); }
      }
      try { await waitTask(await pve('POST', tmplDir + '/oci-registry-pull', { reference: image, filename: file }), 30 * 60 * 1000); }
      catch (e) { if (/toomanyrequests|rate.?limit|\b429\b/i.test(e.message)) { rateLimited = Date.now() + 20 * 60 * 1000; r.retry = true; } throw e; }
      tmpl = await findTmpl();
      if (!tmpl) throw new Error('The image was downloaded but is not on the storage');
    }
    stage = 'create';
    const make = extra => pve('POST', node + '/lxc', {
      vmid, hostname: ('test-' + app.id).slice(0, 60).replace(/[^a-z0-9-]/g, '-').replace(/-+$/, ''), ostemplate: tmpl.volid, rootfs: `${P.storage}:${app.disk || 4}`,
      cores: app.cores || 1, memory: app.memory || 512, swap: 0, unprivileged: 1, onboot: 0,
      net0: `name=eth0,bridge=${P.bridge},ip=dhcp,type=veth`, tags: 'appstore-test', description: 'Compatibility test of ' + app.id + '. Safe to delete.', ...extra,
    }).then(waitTask);
    // Proxmox looks inside the image to see which Linux it is. For one it does not know, say so up front.
    await make({}).catch(async e => { if (!/OS distribution|os-release|\/etc\/passwd/i.test(e.message)) throw e; await sleep(5000); r.unmanaged = true; await make({ ostype: 'unmanaged' }); });
    created = true;
    const cfg = await pve('GET', base + '/config'), set = {}, own = cfg.entrypoint, wrap = wrappable(own);
    if ((app.env || []).length) {
      const env = {};
      for (const kv of (cfg.env || '').split('\0').filter(Boolean)) { const i = kv.indexOf('='); env[kv.slice(0, i)] = kv.slice(i + 1); }
      for (const v of app.env) if (fill(v.value) !== '') env[v.key] = fill(v.value);
      set.env = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0');
    }
    if (wrap) set.entrypoint = waitNet(own);
    if (Object.keys(set).length) await pve('PUT', base + '/config', set);

    // Starts the container and waits up to 90 seconds for a network address.
    const boot = async () => {
      t0 = Date.now();
      try { r.startLog = (await waitTask(await pve('POST', base + '/status/start'), 3 * 60 * 1000)).filter(l => /WARN|error|fail/i.test(l)).slice(0, 3); }
      catch (e) { return { dead: 'Proxmox could not start the container: ' + e.message }; }
      for (let i = 0; i < 45; i++) {
        await sleep(2000);
        if ((await pve('GET', base + '/status/current')).status !== 'running') return { dead: 'The app stopped right after starting' };
        const ip = firstIp(await pve('GET', base + '/interfaces').catch(() => []));
        if (ip) return { ip };
      }
      return { error: 'The container got no network address' };
    };
    // What the app prints at start: run it with the output saved and the container kept alive, then read the file.
    const why = async () => {
      if (!wrap) return;
      try {
        await halt();
        await sleep(8000);
        await pve('PUT', base + '/config', { entrypoint: capture(own) });
        await waitTask(await pve('POST', base + '/status/start'), 3 * 60 * 1000);
        await sleep(25000);
        const out = await readFile(vmid, LOG);
        if (out != null) r.why = summary(out) || undefined;
      } catch {}
    };
    stage = 'start';
    let b = await boot();
    if (b.dead && wrap) {
      // Proxmox needs a moment to tidy up after a start that failed, or the next start trips over it.
      await halt(); await sleep(8000); await pve('PUT', base + '/config', { entrypoint: own }); r.wrapper = b.dead;
      b = await boot();
      if (b.dead && /monitor socket|not running|timeout/i.test(b.dead)) { await halt(); await sleep(15000); b = await boot(); }
      if (!b.dead) r.plain = true;
    }
    if (b.dead || b.error) { if (b.dead) await why(); throw new Error(b.dead || b.error); }
    stage = 'run';
    // 40 seconds in which it must not stop; with a web page, up to 3 minutes for the page to answer.
    let web = !app.port;
    for (const until = Date.now() + (app.port ? 180000 : 40000), settle = Date.now() + 40000; Date.now() < until; await sleep(4000)) {
      if ((await pve('GET', base + '/status/current')).status !== 'running') { const secs = Math.round((Date.now() - t0) / 1000); await why(); throw new Error(`The app stopped ${secs} seconds after starting`); }
      if (!web && (r.http = await answers(b.ip, app))) web = true;
      if (web && Date.now() > settle) break;
    }
    if (!web) { await why(); throw new Error(`The container runs, but nothing answers on port ${app.port}`); }
    r.ok = true; r.secs = Math.round((Date.now() - t0) / 1000);
    delete r.wrapper;
  } catch (e) { r.stage = stage; r.error = e.message.slice(0, 400); }
  finally {
    if (created && !(flag('keep') && !r.ok)) {
      const remove = async () => { await halt(); await waitTask(await pve('DELETE', base, { purge: 1, 'destroy-unreferenced-disks': 1 }), 120000); };
      try { await remove().catch(async () => { await sleep(20000); await remove(); }); }
      catch (e) { r.cleanup = 'Could not delete test container ' + vmid + ': ' + e.message; }
    }
    if (tmpl) await pve('DELETE', `${tmplDir}/content/${encodeURIComponent(tmpl.volid)}`).catch(e => { r.cleanup = (r.cleanup ? r.cleanup + '; ' : '') + 'Could not delete the downloaded image: ' + e.message; });
  }
  return r;
}

(async () => {
  const only = opt('only') && opt('only').split(',');
  const todo = catalog.filter(a => only ? only.includes(a.id) : flag('retest') ? true : flag('failed') ? results[a.id] && !results[a.id].ok : !results[a.id] || results[a.id].retry);
  const pveVersion = (await pve('GET', '/version')).version, jobs = Math.max(1, Math.min(6, Number(opt('jobs')) || 3)), budget = Number(opt('memory')) || 2048;
  const used = new Set((await pve('GET', '/cluster/resources', { type: 'vm' })).map(g => g.vmid));
  console.log(`Testing ${todo.length} of ${catalog.length} apps on Proxmox VE ${pveVersion}, up to ${jobs} at a time. Results: ${OUT}`);
  let done = 0, inUse = 0; const total = todo.length, tries = {};
  await Promise.all(Array.from({ length: jobs }, async (_, w) => {
    let vmid = FIRST_ID + w; while (used.has(vmid)) vmid += jobs;
    for (;;) {
      // The next app that fits in the memory still free; a big app waits until it can run alone.
      const i = todo.findIndex(a => inUse === 0 || inUse + (a.memory || 512) <= budget);
      if (i < 0) { if (!todo.length) return; await sleep(3000); continue; }
      const app = todo.splice(i, 1)[0], mem = app.memory || 512;
      inUse += mem;
      let r;
      try { r = await testApp(app, vmid); } catch (e) { r = { ok: false, stage: 'test', error: e.message, retry: true }; }
      inUse -= mem;
      // An image that could not be downloaded because of a rate limit goes back in the queue, twice at most.
      if (r.retry && (tries[app.id] = (tries[app.id] || 0) + 1) <= 2) { todo.push(app); console.log(`[wait] ${app.id}: the registry limits downloads, trying again later`); continue; }
      r.date = today(); r.pve = pveVersion; results[app.id] = r; save();
      console.log(`[${++done}/${total}] ${r.ok ? 'OK  ' : 'FAIL'} ${app.id}${r.ok ? ` (${r.secs}s${r.plain ? ', own start command' : ''})` : ` - ${r.stage}: ${r.error}`}${r.cleanup ? ' !! ' + r.cleanup : ''}`);
    }
  }));
  const all = catalog.map(a => results[a.id]).filter(Boolean);
  console.log(`Done. ${all.filter(r => r.ok).length} work, ${all.filter(r => !r.ok).length} fail, ${catalog.length - all.length} not tested.`);
})().catch(e => { console.error(e.message); process.exit(1); });
