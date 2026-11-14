'use strict';
// Maintenance tool: fills in "repo" and "screenshots" for each app in catalog.json.
// It reads each project's README on GitHub, picks the images that look like real
// screenshots and checks that every one of them actually loads.
// Run from the repository root:  node tools/screenshots.js
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'catalog.json');

const REPOS = {
  'uptime-kuma': 'louislam/uptime-kuma', grafana: 'grafana/grafana', jellyfin: 'jellyfin/jellyfin', navidrome: 'navidrome/navidrome',
  kavita: 'Kareadita/Kavita', jellyseerr: 'fallenbagel/jellyseerr', sonarr: 'Sonarr/Sonarr', radarr: 'Radarr/Radarr', prowlarr: 'Prowlarr/Prowlarr',
  vaultwarden: 'dani-garcia/vaultwarden', 'adguard-home': 'AdguardTeam/AdGuardHome', homepage: 'gethomepage/homepage', 'it-tools': 'CorentinTh/it-tools',
  'stirling-pdf': 'Stirling-Tools/Stirling-PDF', excalidraw: 'excalidraw/excalidraw', memos: 'usememos/memos', 'actual-budget': 'actualbudget/actual',
  mealie: 'mealie-recipes/mealie', freshrss: 'FreshRSS/FreshRSS', gitea: 'go-gitea/gitea', n8n: 'n8n-io/n8n', 'node-red': 'node-red/node-red',
  syncthing: 'syncthing/syncthing', nginx: 'nginx/nginx', whoami: 'traefik/whoami', audiobookshelf: 'advplyr/audiobookshelf', lidarr: 'Lidarr/Lidarr',
  bazarr: 'morpheus65535/bazarr', overseerr: 'sct/overseerr', tautulli: 'Tautulli/Tautulli', 'calibre-web': 'janeczku/calibre-web', komga: 'gotson/komga',
  metube: 'alexta69/metube', pinchflat: 'kieraneglin/pinchflat', qbittorrent: 'qbittorrent/qBittorrent', transmission: 'transmission/transmission',
  sabnzbd: 'sabnzbd/sabnzbd', photoprism: 'photoprism/photoprism', nextcloud: 'nextcloud/server', filebrowser: 'filebrowser/filebrowser',
  'pingvin-share': 'stonith404/pingvin-share', psitransfer: 'psi-4ward/psitransfer', pairdrop: 'schlagmichdoch/PairDrop', dashy: 'Lissy93/dashy',
  heimdall: 'linuxserver/Heimdall', homarr: 'homarr-labs/homarr', flame: 'pawelmalak/flame', gatus: 'TwiN/gatus', beszel: 'henrygd/beszel',
  prometheus: 'prometheus/prometheus', netdata: 'netdata/netdata', changedetection: 'dgtlmoon/changedetection.io', openspeedtest: 'openspeedtest/Speed-Test',
  myspeed: 'gnmyt/myspeed', gotify: 'gotify/server', 'nginx-proxy-manager': 'NginxProxyManager/nginx-proxy-manager', caddy: 'caddyserver/caddy',
  technitium: 'TechnitiumSoftware/DnsServer', searxng: 'searxng/searxng', whoogle: 'benbusby/whoogle-search', cyberchef: 'gchq/CyberChef', drawio: 'jgraph/drawio',
  'omni-tools': 'iib0011/omni-tools', convertx: 'C4illin/ConvertX', privatebin: 'PrivateBin/PrivateBin', microbin: 'szabodanika/microbin', '2fauth': 'Bubka/2FAuth',
  vikunja: 'go-vikunja/vikunja', trilium: 'TriliumNext/Trilium', kanboard: 'kanboard/kanboard', linkding: 'sissbruecker/linkding', flatnotes: 'dullage/flatnotes',
  silverbullet: 'silverbulletmd/silverbullet', dokuwiki: 'dokuwiki/dokuwiki', grocy: 'grocy/grocy', kitchenowl: 'TomBursch/kitchenowl', homebox: 'sysadminsmedia/homebox',
  wallos: 'ellite/Wallos', docuseal: 'docusealco/docuseal', baikal: 'sabre-io/Baikal', radicale: 'Kozea/Radicale', ghost: 'TryGhost/Ghost',
  linkstack: 'LinkStackOrg/LinkStack', gogs: 'gogs/gogs', 'code-server': 'coder/code-server', adminer: 'vrana/adminer', pgadmin: 'pgadmin-org/pgadmin4',
  postgres: 'postgres/postgres', mariadb: 'MariaDB/server', redis: 'redis/redis', influxdb: 'influxdata/influxdb', esphome: 'esphome/esphome',
  homebridge: 'homebridge/homebridge', 'open-webui': 'open-webui/open-webui', ollama: 'ollama/ollama', minecraft: 'itzg/docker-minecraft-server',
};
const NOT_A_SCREENSHOT = /shields\.io|badge|\.svg(\?|#|$)|logo|icon|sponsor|opencollective|avatar|contributors|contrib\.rocks|star-history|starchart|deploy|button|codecov|crowdin|weblate|paypal|donat|buymeacoffee|ko-fi|liberapay|patreon|discord|twitter|license|repobeats|trendshift|producthunt|gitpod|vercel|netlify|digitalocean|jetbrains|browserstack|hosted|powered|partner|backer|supporter|flag|qr-?code|wechat|alipay|banner|header|hero|mascot/i;

const get = (url, ms = 20000) => fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'catalog-screenshot-check' } });

function size(buf, type) { // [width, height] or null
  try {
    if (/png/.test(type)) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (/gif/.test(type)) return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    if (/jpe?g/.test(type)) for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch {}
  return null;
}
async function isScreenshot(url) {
  try {
    const r = await get(url);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\/(png|jpe?g|gif|webp)/.test(type)) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 30e3 || buf.length > 6e6) return false;   // too small is an icon, too big is a slow page
    const s = size(buf, type);
    if (!s) return /webp/.test(type);
    return s[0] >= 500 && s[0] / s[1] > 0.4 && s[0] / s[1] < 3.2; // wide enough, not a strip-shaped banner
  } catch { return false; }
}
async function readme(repo) {
  for (const name of ['README.md', 'docs/README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.rst', 'README']) {
    const base = `https://raw.githubusercontent.com/${repo}/HEAD/`;
    try { const r = await get(base + name); if (r.ok) return { text: await r.text(), base }; } catch {}
  }
  return null;
}
function images(text, base) {
  const out = [];
  const add = (src, alt, tag = '') => {
    const w = /width=["']?(\d+)/i.exec(tag);
    if (!src || (w && Number(w[1]) < 300) || NOT_A_SCREENSHOT.test(src + ' ' + alt)) return;
    try {
      let u = new URL(src.replace(/&amp;/g, '&'), base).href.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//, '$1/raw/');
      if (/^https:/.test(u) && !out.includes(u)) out.push(u);
    } catch {}
  };
  const re = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*>/gi;
  for (let m; (m = re.exec(text));) {
    if (m[2]) add(m[2], m[1]);
    else add((/src=["']([^"']+)/i.exec(m[0]) || [])[1], (/alt=["']([^"']*)/i.exec(m[0]) || [])[1] || '', m[0]);
  }
  return out;
}
async function one(app) {
  delete app.repo; delete app.screenshots;
  const repo = REPOS[app.id]; if (!repo) return `${app.id}: no repository listed`;
  const r = await readme(repo); if (!r) return `${app.id}: README not found for ${repo}`;
  app.repo = repo;
  const shots = [];
  for (const u of images(r.text, r.base).slice(0, 12)) { if (shots.length < 4 && await isScreenshot(u)) shots.push(u); }
  if (shots.length) app.screenshots = shots;
  return `${app.id}: ${shots.length} screenshot(s)`;
}
(async () => {
  const catalog = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const only = process.argv.slice(2); // optional: app ids to refresh, default all
  const todo = only.length ? catalog.filter(a => only.includes(a.id)) : catalog;
  for (let i = 0; i < todo.length; i += 8) console.log((await Promise.all(todo.slice(i, i + 8).map(one))).join('\n'));
  fs.writeFileSync(FILE, '[\n' + catalog.map(a => '  ' + JSON.stringify(a)).join(',\n') + '\n]\n');
  const n = catalog.filter(a => a.screenshots).length;
  console.log(`\n${n} of ${catalog.length} apps have screenshots; ${catalog.filter(a => a.repo).length} have a source link.`);
})();
