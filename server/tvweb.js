/*
 * tvweb.js - on-TV monitor + control web server for a rooted LG webOS TV.
 * Verified on OLED65B8SLC / webOS 4.4.3.
 *
 * IMPORTANT: the TV ships node v0.12.2 (2015). This file must stay ES5 -
 * no arrow functions, no const/let, no template literals, no async/await,
 * no Object.assign; scripts/check-es5.py enforces it. The dashboard in
 * assets/ui.html is NOT restricted: it runs in a browser, not on the TV.
 *
 * Run:  node tvweb.js
 */

var http = require('http');
var fs = require('fs');
var THERMAL_PRESENT = fs.existsSync('/proc/lg/pm/temperature');
var EMMC_WEAR_PRESENT = fs.existsSync('/sys/block/mmcblk0/device/life_time');
var url = require('url');
var net = require('net');
var tls = require('tls');
var child_process = require('child_process');
var path = require('path');
var execFile = child_process.execFile;
var zlib = require('zlib');

/*
 * Bump on release, and tag the release to match: the dashboard turns this into
 * a link to /releases/tag/v<version>, so a value with no tag behind it gives a
 * 404 rather than a wrong page.
 */
var TVWEB_VERSION = '0.34.2';

// ---------------------------------------------------------------- config
var CONFIG = {
  // The dashboard. Turn this off if you drive everything from Home Assistant:
  // it is an unauthenticated control endpoint unless `token` is set, and an
  // MQTT-only install has no reason to expose one.  { "web": { "enabled": false } }
  web: { enabled: true },

  port: 8080,           // dashboard port
  host: '0.0.0.0',      // '127.0.0.1' to keep it TV-local only

  // Anyone who can reach this port can use the controls below.
  allowControl: true,   // volume, screen off/on, input switching, toast

  // Power off / reboot ship DISABLED, because there is no authentication
  // unless `token` is set and a fresh install should not expose "turn the TV
  // off" to the whole network. Enable in your own config.json:
  //     { "allowPower": true }
  allowPower: false,

  // Optional shared secret. If non-empty, every /api/ request must carry
  // ?k=<token>. Keeps casual LAN devices out.
  token: '',

  // Home Assistant & MQTT Integration
  mqtt: {
    // Off until a broker is configured. Shipping an address here would point
    // every install at whatever happens to be at that IP on the user's LAN.
    enabled: false,
    host: '',
    // null means "pick by transport": 1883 plain, 8883 with tls. A literal
    // 1883 here would survive the config merge and silently defeat that.
    port: null,
    // Encrypt the broker connection. Without this the username and password
    // cross the network in cleartext. Port defaults to 8883 when enabled.
    tls: false,
    tlsRejectUnauthorized: true,
    username: '',
    password: '',
    topicPrefix: 'lgtv',
    discoveryPrefix: 'homeassistant',
    telemetryIntervalMs: 10000
  },

  device: {
    id: 'lg_tv',
    name: '',
    model: '',
    manufacturer: 'LG'
  }
};

/* Scanned before loadConfig so --config can point at an alternative file:
   handy for a second TV, or for testing without touching the live config. */
function argvConfigPath() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--config' && a[i + 1]) return a[i + 1];
  }
  return null;
}

/*
 * Where a settings write goes. Set to whichever file loadConfig() actually
 * read; when none exists yet (a fresh install) it stays at the install path,
 * so the first save from the dashboard creates the file the boot hook reads.
 */
var CONFIG_FILE = '/var/lib/tvweb/config.json';

function loadConfig() {
  var override = argvConfigPath();
  var paths = override ? [override] : ['/var/lib/tvweb/config.json', './config.json'];
  if (override) CONFIG_FILE = override;
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        var raw = fs.readFileSync(paths[i], 'utf8');
        var userConf = JSON.parse(raw);
        for (var k in userConf) {
          if (typeof userConf[k] === 'object' && userConf[k] !== null && !Array.isArray(userConf[k])) {
            CONFIG[k] = CONFIG[k] || {};
            for (var sk in userConf[k]) {
              CONFIG[k][sk] = userConf[k][sk];
            }
          } else {
            CONFIG[k] = userConf[k];
          }
        }
        /*
         * The file holds broker credentials in plaintext. Default webOS perms
         * leave it world-readable (0644), and TV apps run as wam/nobody - so
         * tighten it to owner-only. Note this is mitigation, not a fix: while
         * the homebrew root telnet on port 23 is open, nothing on this TV is
         * secret. Use a dedicated, ACL-restricted broker user.
         */
        try {
          var mode = fs.statSync(paths[i]).mode & 0777;
          if (mode !== 0600) {
            fs.chmodSync(paths[i], 0600);
            console.log('tightened permissions on ' + paths[i] + ' to 0600');
          }
        } catch (e) {
          console.error('warning: could not chmod ' + paths[i] + ': ' + e.message);
        }
        CONFIG_FILE = paths[i];
        console.log('loaded configuration from ' + paths[i]);
        break;
      }
    } catch (e) {
      console.error('warning: error reading config from ' + paths[i] + ':', e.message);
    }
  }
}
loadConfig();

/*
 * Command-line overrides, applied after the config file so they always win.
 * Mainly so a second instance can be run alongside the live one for preview
 * without stealing its port or double-publishing MQTT discovery:
 *   node tvweb.js --port 8081 --no-mqtt
 */
(function applyArgv() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--port' && a[i + 1]) CONFIG.port = parseInt(a[++i], 10) || CONFIG.port;
    else if (a[i] === '--host' && a[i + 1]) CONFIG.host = a[++i];
    else if (a[i] === '--config') i++;   // consumed before loadConfig
    else if (a[i] === '--no-mqtt') { CONFIG.mqtt = CONFIG.mqtt || {}; CONFIG.mqtt.enabled = false; }
    else if (a[i] === '--no-control') CONFIG.allowControl = false;
  }
})();

// ---------------------------------------------------------------- helpers
function rd(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); }
  catch (e) { return null; }
}

function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

function meminfo() {
  var out = {}, raw = rd('/proc/meminfo');
  if (!raw) return out;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

var EOL_MAP = { 1: 'Normal', 2: 'Warning', 3: 'Urgent' };
var EMMC_CACHE = null;

/* eMMC DEVICE_LIFE_TIME_EST: 0x01 = 0-10% of rated write cycles used (>90% health remaining). */
function emmcInfo() {
  if (EMMC_CACHE) return EMMC_CACHE;
  var raw = rd('/sys/block/mmcblk0/device/life_time');
  var eolRaw = rd('/sys/block/mmcblk0/device/pre_eol_info');
  /*
   * Both nodes are absent on webOS 3.x. Reporting a healthy drive because the
   * wear counter could not be read is the same mistake as rendering 0 C for a
   * missing thermal sensor: it states as fact something never measured.
   */
  // The kernel prints pre_eol_info as 0x%02X, so parse the value rather than
  // match its text: '0x01' and '01' both mean Normal. 0x00 is "not defined".
  var eol = EOL_MAP[parseInt(eolRaw, 16)] || 'unknown';
  if (!raw) {
    EMMC_CACHE = { life: 'unknown', wear: 'unknown', health: 'unknown', eol: eol };
    return EMMC_CACHE;
  }

  var parts = raw.split(/\s+/), wearList = [], minHealth = 100;
  for (var i = 0; i < parts.length; i++) {
    var n = parseInt(parts[i], 16);
    if (!n) continue;
    if (n >= 11) {
      wearList.push('>100%');
      minHealth = 0;
    } else {
      wearList.push(((n - 1) * 10) + '-' + (n * 10) + '%');
      var rem = 100 - (n * 10);
      if (rem < minHealth) minHealth = rem;
    }
  }
  /*
   * The controller reports a band per region, and on a healthy drive they are
   * all the same - "0-10% / 0-10%" is one fact stated twice, and it wrapped to
   * two lines in the dashboard's cell. Collapse them when they agree; a drive
   * whose regions have diverged still shows every band, which is the case
   * where the detail earns its space.
   */
  var uniqWear = [];
  for (var u = 0; u < wearList.length; u++) {
    if (uniqWear.indexOf(wearList[u]) === -1) uniqWear.push(wearList[u]);
  }
  var wearStr = uniqWear.length ? uniqWear.join(' / ') : '0-10%';
  // The wear band inverted. Kept for anyone templating on it; nothing in this
  // project presents it, because next to `wear` it is the same fact twice.
  var healthStr = (minHealth >= 90) ? '>90% (Healthy)' : (minHealth + '% remaining');
  EMMC_CACHE = {
    life: wearStr,    // backwards-compatible with old HA discovery template
    wear: wearStr,
    health: healthStr,
    eol: eol
  };
  return EMMC_CACHE;
}

/*
 * Which CPUs are actually running. The TV parks cores under light load, but
 * /proc/lg/pm/status keeps a slot in its load vector for every core whether
 * or not it is online - a parked one reads 0, or holds whatever it last
 * reported before it went down. Observed on a G4: "load: 13 11 11 29" while
 * only cpu0-2 were online, so that trailing 29 belonged to a core that had
 * stopped. Publishing those next to live figures invents cores.
 *
 * /sys/devices/system/cpu/online is the authoritative list and gives indices
 * ("0-1", "0,2-3"), which matters because a slot's position is its core
 * number. cpu_num in the LG file is only a count, so it stands in when sysfs
 * is unavailable and the cores are assumed to be the lowest indices.
 */
function onlineCpus(status) {
  var raw = rd('/sys/devices/system/cpu/online');
  if (raw) {
    var idx = [], parts = raw.trim().split(',');
    for (var i = 0; i < parts.length; i++) {
      var range = parts[i].split('-');
      var lo = parseInt(range[0], 10);
      var hi = range.length > 1 ? parseInt(range[1], 10) : lo;
      if (isNaN(lo) || isNaN(hi)) continue;
      for (var c = lo; c <= hi; c++) idx.push(c);
    }
    if (idx.length) return idx;
  }
  var m = (status || '').match(/cpu_num:\s*(\d+)/);
  if (!m) return null;                      // no idea which are live
  var n = parseInt(m[1], 10), out = [];
  for (var k = 0; k < n; k++) out.push(k);
  return out;
}

/*
 * webOS 4.x reports this in kHz (1200000), webOS 9+ in MHz (1200), so a fixed
 * divisor turns a 1.2 GHz SoC into "1 MHz" on the newer sets. No TV SoC runs
 * anywhere near 10 GHz, so a value above that is taken as the kHz form.
 *
 * Only those two conventions have been seen, so the result is bounded rather
 * than trusted: a set reporting Hz would land far outside a plausible clock,
 * and nothing is better than a confident wrong figure.
 */
function socMhz() {
  var v = num(rd('/proc/lg/pm/frequency'), 0);
  if (!v || v < 0) return null;
  var mhz = Math.round(v > 10000 ? v / 1000 : v);
  return (mhz >= 100 && mhz <= 10000) ? mhz : null;
}

/*
 * What swap is actually backed by. The B8 swaps to zram, but this is not
 * universal: a G4 swaps to a flash partition (/dev/f2io-0) and leaves zram0
 * present with disksize 0. Calling both "zram" understated the cost, since
 * compressed RAM costs no writes and a partition wears the eMMC.
 *
 * The largest device wins, which is the one carrying the pages.
 */
var SWAP_BACKING_CACHE = null;

function swapBacking() {
  if (SWAP_BACKING_CACHE !== null) return SWAP_BACKING_CACHE;
  var raw = rd('/proc/swaps');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null, bestSize = -1;
  for (var i = 1; i < lines.length; i++) {          // row 0 is the header
    var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
    if (f.length < 3 || !f[0]) continue;
    var size = parseInt(f[2], 10);
    if (isNaN(size) || size <= bestSize) continue;
    bestSize = size;
    best = /zram/i.test(f[0]) ? 'zram' : (f[1] === 'file' ? 'file' : 'flash');
  }
  SWAP_BACKING_CACHE = best;
  return best;
}

function wifi() {
  var raw = rd('/proc/net/wireless');
  if (!raw) return null;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('wlan0') !== -1) {
      var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
      var link = parseFloat(f[2]), level = parseFloat(f[3]);
      /*
       * A wired set still has a wlan0 row, reading zero across the board
       * because the radio is not associated. Reporting that as 0 dBm states a
       * measurement that was never taken - the same mistake as 0 C for a
       * missing thermal sensor.
       */
      if (!link && !level) return null;
      // webOS 9+ (C2) exposes signal as unsigned in /proc/net/wireless:
      // 181 means -75 dBm. iw confirms: "signal: -75 dBm".
      if (level > 127) level = level - 256;
      return { link: link, level: level };
    }
  }
  return null;
}

/*
 * Live first, then busiest. Ranking on byte count alone would keep choosing a
 * link that has since been unplugged: a set moved from Wi-Fi to ethernet has
 * a dormant wlan0 holding more lifetime bytes than eth0 will accumulate for
 * days, and its idle counters would report zero throughput on a busy TV -
 * which is the fault this replaced, in a new form.
 *
 * A kernel too old to publish operstate or carrier leaves every interface
 * unranked, and the busiest still wins.
 */
function ifaceRank(name) {
  var st = rd('/sys/class/net/' + name + '/operstate');
  if (st) {
    st = st.trim();
    if (st === 'up') return 2;
    if (st === 'down') return 0;
    return 1;                                       // "unknown" is not "down"
  }
  var car = rd('/sys/class/net/' + name + '/carrier');
  if (!car) return 1;
  return car.trim() === '1' ? 2 : 0;
}

/*
 * The address a magic packet has to be sent to. Waking a set is the one thing
 * this server cannot do - it is not running when the TV is off - so the README
 * documents Wake-on-LAN for it and leaves the address for the reader to find
 * in the TV's menus. The set knows it.
 *
 * Read for whichever interface the throughput came from, so a TV on Wi-Fi
 * reports its Wi-Fi address rather than a wired one with nothing plugged in.
 * An all-zero address is a placeholder for an interface that has none.
 */
var MAC_CACHE = {};

function macAddress(iface) {
  if (!iface) return null;
  if (MAC_CACHE[iface]) return MAC_CACHE[iface];
  var raw = rd('/sys/class/net/' + iface + '/address');
  if (!raw) return null;
  var mac = raw.trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  if (mac === '00:00:00:00:00:00') return null;
  MAC_CACHE[iface] = mac;
  return mac;
}

/*
 * Whichever interface is actually carrying traffic. This matched wlan0 alone,
 * so every wired set reported zero throughput forever - the counters it wanted
 * were on eth0. Loopback is excluded.
 */
function netBytes() {
  var raw = rd('/proc/net/dev');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null;
  for (var i = 0; i < lines.length; i++) {
    // Split on the first colon only: the counters follow it, and a long byte
    // count can run straight up against it with no space.
    var idx = lines[i].indexOf(':');
    if (idx === -1) continue;                       // the two header rows
    var name = lines[i].slice(0, idx).replace(/\s+/g, '');
    if (!name || name === 'lo') continue;
    var f = lines[i].slice(idx + 1).replace(/\s+/g, ' ').trim().split(' ');
    var rx = parseInt(f[0], 10), tx = parseInt(f[8], 10);
    if (isNaN(rx) || isNaN(tx)) continue;
    var rank = ifaceRank(name);
    if (!best || rank > best.rank || (rank === best.rank && rx > best.rx)) {
      best = { iface: name, rank: rank, rx: rx, tx: tx, t: Date.now() };
    }
  }
  return best;
}

function getVideoSignal() {
  for (var p = 0; p < 4; p++) {
    var raw = rd('/proc/lg/hdmi20/port' + p + '/status');
    if (!raw) continue;
    var isConn = /connected:\s*on/i.test(raw) || /PHY\s+Lock\[1\]/i.test(raw);
    var w = null, h = null, hz = '';
    var wMatch = raw.match(/horizontal-active:\s*(\d+)/);
    var hMatch = raw.match(/vertical-active:\s*(\d+)/);
    var hzMatch = raw.match(/pixel-clock-V:\s*(\d+)\s*Hz/);
    if (wMatch && hMatch) {
      w = wMatch[1];
      h = hMatch[1];
      if (hzMatch) hz = ' @ ' + hzMatch[1] + 'Hz';
    } else {
      var sigM = raw.match(/Sig:\s*\[(\d+)\](?:\(\d+\))?x\[(\d+)\](?:\(\d+\))?@\[(\d+)\]\s*Hz/i);
      if (sigM && parseInt(sigM[1], 10) > 0) {
        w = sigM[1];
        h = sigM[2];
        hz = ' @ ' + sigM[3] + 'Hz';
        isConn = true;
      }
    }
    if (isConn) {
      if (w && h) return w + 'x' + h + hz;
      return 'Connected';
    }
  }
  return null;
}

var cachedRemote = null;
var lastRemoteCheck = 0;

function readRemoteInfo() {
  var now = Date.now();
  if (cachedRemote && (now - lastRemoteCheck < 30000)) return cachedRemote;
  var raw = rd('/mnt/lg/cmn_data/mrcu/mrcu1.info');
  if (!raw) return cachedRemote || null;
  var bMatch = raw.match(/Battery\s*=\s*(\d+)/i);
  var nMatch = raw.match(/Name\s*=\s*([^\r\n]+)/i);
  var macMatch = raw.match(/BDAddr\s*=\s*([^\r\n]+)/i);
  var fwMatch = raw.match(/fwVer\s*=\s*([^\r\n]+)/i);
  if (!bMatch && !nMatch) return cachedRemote || null;
  cachedRemote = {
    battery: bMatch ? parseInt(bMatch[1], 10) : null,
    model: nMatch ? nMatch[1].trim() : null,
    mac: macMatch ? macMatch[1].trim() : null,
    firmware: fwMatch ? fwMatch[1].trim() : null,
    paired: true
  };
  lastRemoteCheck = Date.now();
  return cachedRemote;
}

function getActiveHdmiDiagnostics() {
  for (var p = 0; p < 4; p++) {
    var raw = rd('/proc/lg/hdmi20/port' + p + '/status');
    if (!raw) continue;
    var isConn = /connected:\s*on/i.test(raw) || /PHY\s+Lock\[1\]/i.test(raw) || /is5Vconnected\[1\]/i.test(raw);
    if (!isConn) continue;

    var phyMatch = raw.match(/PHY Mode\[([^\]]+)\]/i);
    var fmtMatch = raw.match(/Video Format\[([^\]]+)\]/i);
    var hdcpMatch = raw.match(/Current HDCP Auth Version => (HDCP\w+)/i);
    var errMatch = raw.match(/PHY Error Count\s*:\s*(\d+)/i);
    var allmMatch = raw.match(/isAllm\[(\d+)\]/i);
    var vrrMatch = raw.match(/isFreeSync\[(\d+)\]/i);
    var vrrMinMax = raw.match(/VRR Min\[(\d+)\]\/Max\[(\d+)\]/i);
    var qmsMatch = raw.match(/QMSMode\[(\d+)\]/i);

    var phyMode = null;
    if (phyMatch) {
      var rawPhy = phyMatch[1].trim();
      if (/FRL 12G 4L/i.test(rawPhy)) phyMode = 'FRL 48 Gbps';
      else if (/FRL 10G 4L/i.test(rawPhy)) phyMode = 'FRL 40 Gbps';
      else if (/FRL 8G 4L/i.test(rawPhy)) phyMode = 'FRL 32 Gbps';
      else if (/FRL 6G 4L/i.test(rawPhy)) phyMode = 'FRL 24 Gbps';
      else if (/FRL 6G 3L/i.test(rawPhy)) phyMode = 'FRL 18 Gbps';
      else if (/FRL 3G 3L/i.test(rawPhy)) phyMode = 'FRL 9 Gbps';
      else if (/3G/i.test(rawPhy)) phyMode = 'TMDS (3G)';
      else if (/6G/i.test(rawPhy)) phyMode = 'TMDS (6G)';
      else phyMode = rawPhy;
    }

    var format = null;
    if (fmtMatch) {
      var rawFmt = fmtMatch[1].trim();
      if (rawFmt === 'R444') format = 'RGB 4:4:4';
      else if (rawFmt === 'Y444') format = 'YCbCr 4:4:4';
      else if (rawFmt === 'Y422') format = 'YCbCr 4:2:2';
      else if (rawFmt === 'Y420') format = 'YCbCr 4:2:0';
      else format = rawFmt;
    }

    var hdcp = null;
    if (hdcpMatch) {
      var rawHdcp = hdcpMatch[1].trim();
      if (rawHdcp === 'HDCP23') hdcp = 'HDCP 2.3';
      else if (rawHdcp === 'HDCP22') hdcp = 'HDCP 2.2';
      else if (rawHdcp === 'HDCP14') hdcp = 'HDCP 1.4';
      else if (rawHdcp === 'HDCP0') hdcp = 'None';
      else hdcp = rawHdcp;
    }

    var isVrr = (vrrMatch && vrrMatch[1] === '1') ||
                (vrrMinMax && (parseInt(vrrMinMax[1], 10) > 0 || parseInt(vrrMinMax[2], 10) > 0));

    /*
     * Null where the line is absent, not 0 or false. An HDMI 2.0 port has a
     * status file and reports as connected, but carries none of the 2.1 lines:
     * a B8 gives the port number and nothing else. Defaulting meant a cable
     * error count of 0 and a VRR of OFF on a set with no counter and no VRR
     * hardware, which reads as a measurement rather than as silence.
     */
    return {
      port: p,
      phy_mode: phyMode,
      chroma: format,
      hdcp: hdcp,
      phy_errors: errMatch ? parseInt(errMatch[1], 10) : null,
      allm: allmMatch ? (allmMatch[1] === '1') : null,
      vrr: (vrrMatch || vrrMinMax) ? !!isVrr : null,
      qms: qmsMatch ? (qmsMatch[1] === '1') : null
    };
  }
  return null;
}

function getPictureEngineInfo() {
  var raw = rd('/proc/lg/pe/hdr_status');
  if (!raw) return null;
  var colMatch = raw.match(/colorimetry:\s*([^,\}]+)/i);
  var hdrMatch = raw.match(/hdrStatus:\s*([^\(,\}]+)/i);
  var peakMatch = raw.match(/peakLuminance:\s*(\d+)/i);

  var colorimetry = null;
  if (colMatch) {
    var rawCol = colMatch[1].trim().toLowerCase();
    if (rawCol === 'bt709') colorimetry = 'BT.709';
    else if (rawCol === 'bt2020') colorimetry = 'BT.2020';
    else if (rawCol === 'bt601') colorimetry = 'BT.601';
    else colorimetry = colMatch[1].trim();
  }

  return {
    colorimetry: colorimetry,
    hdr_mode: hdrMatch ? hdrMatch[1].trim() : null,
    peak_luminance: peakMatch ? parseInt(peakMatch[1], 10) : null
  };
}

var PIC_MODE_MAP = {
  dolbyHdrVivid: 'Dolby Vision Vivid',
  dolbyHdrCinemaBright: 'Dolby Vision Cinema Bright',
  dolbyHdrCinema: 'Dolby Vision Cinema',
  dolbyHdrCinemaHome: 'Dolby Vision Cinema Home',
  dolbyHdrStandard: 'Dolby Vision Standard',
  dolbyHdrGame: 'Dolby Vision Game',
  hdrCinema: 'HDR Cinema',
  hdrCinemaHome: 'HDR Cinema Home',
  hdrStandard: 'HDR Standard',
  hdrGame: 'HDR Game',
  cinema: 'Cinema',
  personalized: 'Personalized',   // reported by webOS 22 sets
  expert1: 'ISF Expert (Bright)',
  expert2: 'ISF Expert (Dark)',
  game: 'Game',
  standard: 'Standard',
  eco: 'Eco',
  technicolor: 'Technicolor',
  technicolorHdr: 'Technicolor HDR',
  hdrEffect: 'HDR Effect',
  vivid: 'Vivid',
  normal: 'Standard'
};

/*
 * Which picture modes the set will accept right now.
 *
 * They depend on the dynamic range of what is playing: under Dolby Vision the
 * only settable modes are the dolbyHdr* ones, and setting an SDR mode is
 * refused with "There is No matched extended item: pictureMode". A fixed list
 * therefore offers buttons that cannot work - which is what the dashboard used
 * to do, showing SDR modes against Dolby Vision content.
 *
 * getSystemSettingValues marks the currently selectable ones visible:true, and
 * that set changes with the source, so it is read rather than assumed.
 */
var lastPicModes = [];

function pictureModes(cb) {
  lunaCached('com.webos.service.settings/getSystemSettingValues',
    { category: 'picture', key: 'pictureMode' }, 10000, function (res) {
      var arr = (res && res.values && res.values.arrayExt) || [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].visible === true && arr[i].active !== false) {
          out.push({ value: arr[i].value, label: formatPicMode(arr[i].value) });
        }
      }
      if (out.length) lastPicModes = out;
      cb(out);
    });
}

function formatPicMode(mode) {
  if (!mode) return 'Standard';
  return PIC_MODE_MAP[mode] || mode;
}

function formatDynamicRange(dr) {
  if (!dr || dr === 'sdr') return 'SDR';
  if (dr === 'dolbyHdr') return 'Dolby Vision';
  if (dr === 'hdr') return 'HDR';
  if (dr === 'technicolorHdr') return 'Technicolor HDR';
  return String(dr).toUpperCase();
}

var inputNameMap = {};
var lastInputScan = 0;

function refreshInputNames(cb) {
  if (Date.now() - lastInputScan < 60000 && Object.keys(inputNameMap).length > 0) {
    if (cb) cb(inputNameMap);
    return;
  }
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    if (res && res.devices && res.devices.length) {
      for (var i = 0; i < res.devices.length; i++) {
        var d = res.devices[i];
        if (d.appId && d.label) {
          var shortId = String(d.appId).replace('com.webos.app.', '');
          inputNameMap[shortId] = d.label;
        }
      }
      lastInputScan = Date.now();
    }
    if (cb) cb(inputNameMap);
  });
}

var TOAST_SOURCE = 'com.webos.app.home';

/* luna-send wrapper via execFile directly, avoiding /bin/sh and shell child leaks.
 * -w 2000 tells luna-send itself to time out after 2 seconds.
 * timeout: 3500 ensures Node kills the child process if it ever stalls.
 * appId, where given, becomes -a: a few services check the caller's registered
 * bus identity rather than anything in the payload, and reject everyone else
 * with "Unknown Source".
 */
function luna(uri, payload, cb, appId) {
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  execFile('/usr/bin/luna-send', args, { timeout: 3500 }, function (err, stdout) {
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (cb) cb(parsed, String(stdout || ''));
  });
}

/*
 * Cache for luna reads whose answers do not change between dashboard ticks.
 * Every luna() call is a fork+exec, and collectStats made ten of them per
 * collection at a 2s tick - roughly five forks a second with the dashboard
 * open. Node 0.12's spawn path can deadlock under that (see the watchdog note
 * in tvwebctl), so set-and-forget settings are now read once per TTL.
 *
 * Any successful control clears the lot, so a setting the user just changed is
 * never served from cache.
 */
var lunaCache = {};

function lunaCached(uri, payload, ttlMs, cb) {
  var key = uri + '|' + JSON.stringify(payload || {});
  var hit = lunaCache[key];
  if (hit && (Date.now() - hit.t < ttlMs)) return cb(hit.v, hit.raw);
  luna(uri, payload, function (parsed, raw) {
    // Only a real answer is worth pinning; a failed read should be retried.
    if (parsed) lunaCache[key] = { t: Date.now(), v: parsed, raw: raw };
    cb(parsed, raw);
  });
}

function clearLunaCache() { lunaCache = {}; }

/*
 * Platform code to the processor it always means. LG reports the code either
 * as _O22_ from the env block or o22 from /proc/lg/base/chip_name, so both
 * normalise to one key.
 *
 * O24 is deliberately absent. It is the 2024 platform, and unlike the earlier
 * ones it does not name a single processor - a G4 on O24 is an Alpha 11, a C4
 * on O24 is an Alpha 9 Gen 7 - so any one name here would be wrong on half the
 * sets that report it. An unmapped code falls through to the bare code, which
 * reads "O24" rather than the raw "_O24_" that was reaching the sensor.
 */
var SOC_ARCH = {
  O22: 'Alpha 9 Gen 5 (O22)',
  O20: 'Alpha 9 Gen 3 (O20)',
  O18: 'Alpha 9 Gen 1 (O18)',
  M16P: 'Alpha 7 (M16P)',
  M16PLUS: 'Alpha 7 (M16P)'
};

function socArchName(raw) {
  if (!raw) return null;
  var key = String(raw).replace(/^_+|_+$/g, '').toUpperCase();
  if (!key) return null;
  return SOC_ARCH[key] || key;
}

function detectWebosVersion(sdkVersion) {
  var raw = rd('/etc/issue') || rd('/etc/issue.net') || '';
  var m = raw.match(/webOS(?:\s+TV)?\s+([\d\.]+)/i);
  if (m) return m[1];
  var sf = rd('/etc/starfish-release') || '';
  var sm = sf.match(/release\s+([\d\.]+)/i);
  if (sm) return sm[1];
  if (sdkVersion) return String(sdkVersion);
  return null;
}

var HARDWARE_INFO = {
  webos: null,
  socArch: null,
  ram: null,
  refreshRate: null,
  eyeSensor: null,
  cell: null,
  tconFirmware: null,
  tconModule: null
};

function detectHardwareInfo(sdkVersion, cb) {
  HARDWARE_INFO.webos = detectWebosVersion(sdkVersion);
  var envRaw = rd('/var/luna/preferences/environmentCondition');
  if (envRaw) {
    try {
      var env = JSON.parse(envRaw);
      var bStr = env.boardTypeStr || env.socChip || rd('/proc/lg/base/chip_name') || '';
      if (bStr) {
        bStr = bStr.trim();
        HARDWARE_INFO.socArch = socArchName(bStr);
      }
      if (env.ddrSize) HARDWARE_INFO.ram = env.ddrSize;
      if (env.panelOutputFrameRate) HARDWARE_INFO.refreshRate = env.panelOutputFrameRate + ' Hz';
      if (env.digitalEyeMode) HARDWARE_INFO.eyeSensor = env.digitalEyeMode;
      else if (env.isDigitalEye === 'true') HARDWARE_INFO.eyeSensor = 'Digital Eye';
    } catch (e) {}
  }
  if (!HARDWARE_INFO.socArch) {
    // Same codes, lower case and without the underscores: "o24".
    var chip = rd('/proc/lg/base/chip_name');
    if (chip) HARDWARE_INFO.socArch = socArchName(chip.trim());
  }

  // Query panelcontroller (webOS 9+)
  luna('com.webos.service.panelcontroller/getOledCellInfo', {}, function (cellRes) {
    if (cellRes && cellRes.cellInfo) HARDWARE_INFO.cell = cellRes.cellInfo;
    luna('com.webos.service.panelcontroller/getOledTconInfo', {}, function (tconRes) {
      if (tconRes && tconRes.tconParamForInstart) {
        HARDWARE_INFO.tconFirmware = tconRes.tconParamForInstart.tconFpgaFirmwareVer || null;
        HARDWARE_INFO.tconModule = tconRes.tconParamForInstart.tconModuleInfo || null;
      }
      if (cb) cb();
    });
  });
}

function detectDeviceInfo(cb) {
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'] },
    function (res) {
      if (res && res.modelName) {
        if (!CONFIG.device.model || CONFIG.device.model === 'OLED65B8SLC' || CONFIG.device.model === 'webOS TV') {
          CONFIG.device.model = res.modelName;
        }
        if (!CONFIG.device.name || CONFIG.device.name === 'LG webOS TV' || CONFIG.device.name === 'LG OLED B8 TV') {
          CONFIG.device.name = 'LG ' + res.modelName;
        }
        if (res.firmwareVersion) {
          CONFIG.device.sw_version = res.firmwareVersion;
        }
        console.log('device detected: ' + (CONFIG.device.name || 'LG TV') + ' (model: ' + CONFIG.device.model + ') fw: ' + (res.firmwareVersion || '?'));
      }
      if (!CONFIG.device.name) CONFIG.device.name = 'LG webOS TV';
      if (!CONFIG.device.model) CONFIG.device.model = 'webOS TV';
      detectHardwareInfo((res && res.sdkVersion) || null, function () {
        if (cb) cb();
      });
    }
  );
}

// Keyed on both the soundOutput setting and the audio service's scenario name
// with its mastervolume_ prefix removed - the two use the same output names,
// except that a scenario can also name a combination.
var SOUND_OUTPUT_MAP = {
  tv_speaker: 'TV Speaker',
  external_arc: 'HDMI ARC',
  optical: 'Optical',
  external_optical: 'Optical',
  headphone: 'Headphone / AUX',
  bt_soundbar: 'Bluetooth',
  external_speaker: 'External Speaker',
  lineout: 'Line Out',
  soundbar: 'LG Sound Sync',
  tv_speaker_headphone: 'TV Speaker + Headphone',
  internal: 'TV Speaker'
};

function formatSoundOutput(so) {
  if (!so) return 'TV Speaker';
  return SOUND_OUTPUT_MAP[so] || so;
}

var installedApps = [];
var lastAppsScan = 0;

function refreshInstalledApps(cb) {
  var now = Date.now();
  if (installedApps.length > 0 && (now - lastAppsScan < 300000)) {
    if (cb) cb(installedApps);
    return;
  }
  luna('com.webos.applicationManager/listApps', {}, function (res) {
    if (res && Array.isArray(res.apps)) {
      var list = [];
      for (var i = 0; i < res.apps.length; i++) {
        var a = res.apps[i];
        if (a && a.id && a.visible !== false && a.id.indexOf('com.webos.app.container') !== 0) {
          list.push({
            id: a.id,
            title: a.title || a.id
          });
        }
      }
      list.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
      installedApps = list;
      lastAppsScan = Date.now();
    }
    if (cb) cb(installedApps);
  });
}

var ADBLOCK_HOSTS_FILE = '/var/lib/tvweb/adblock_hosts';
/*
 * Written into the table and looked for in the live /etc/hosts. Asking
 * /proc/mounts whether anything is mounted there answers a different question:
 * webosbrew bind-mounts that path itself on some installs, and this then
 * reported the blocker as on while none of these domains were in effect.
 */
var ADBLOCK_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-mqtt)';
var ADBLOCK_FLAG_FILE = '/var/lib/tvweb/adblock_enabled';
/* Ad, tracking and telemetry hosts. Nothing on the TV needs to reach them. */
var ADBLOCK_ADS = [
  'ad.lgsmartad.com',
  'ibis.lgappstv.com',
  'ibs.lgappstv.com',
  'lgsmartad.com',
  'rdx.lgtvcommon.com',
  'aic.lgtvcommon.com',
  'smartclip.com',
  'smartclip-services.com',
  'yumenetworks.com'
];

/*
 * LG's own service platform and content delivery. These carry ads and
 * recommendations, but they carry the Content Store and firmware updates too:
 * com.webos.appInstallService on a B8 points at http://GB.lgtvsdp.com. That is
 * what the "everything" tier costs, and why it is not the default.
 */
var ADBLOCK_PLATFORM = [
  'lgtvsdp.com',
  'us.lgtvsdp.com',
  'gb.lgtvsdp.com',
  'eu.lgtvsdp.com',
  /* webOS 9 moved the store: a C2 on 9.2.2 installs from GB.nextlgsdp.com. */
  'nextlgsdp.com',
  'us.nextlgsdp.com',
  'gb.nextlgsdp.com',
  'eu.nextlgsdp.com',
  'ngfts.lge.com',
  'aic-ngfts.lge.com'
];

var ADBLOCK_DOMAINS = ADBLOCK_ADS.concat(ADBLOCK_PLATFORM);

/*
 * The store's own server, as the TV has it. lgtvsdp.com on webOS 4 and
 * nextlgsdp.com on webOS 9 are both in the list above, but a set this has not
 * seen could name a third - and then the full tier would claim to block the
 * store while leaving it reachable.
 */
function storeHost() {
  try {
    var j = JSON.parse(rd('/var/palm/data/com.webos.appInstallService/serverInfo') || '{}');
    var m = /^[a-z]+:\/\/([^\/:?#]+)/i.exec(String(j.serverUrl || ''));
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}

function adBlockPlatform() {
  var list = ADBLOCK_PLATFORM.slice();
  var host = storeHost();
  if (host && list.indexOf(host) === -1) list.push(host);
  return list;
}

function adBlockList(mode) {
  return mode === 'full' ? ADBLOCK_ADS.concat(adBlockPlatform()) : ADBLOCK_ADS;
}

var cachedAdBlockActive = null;
var lastAdBlockCheck = 0;

/*
 * Which tier is mounted. The flag file holds the mode; installs made before
 * there was a choice wrote '1', which was today's "full".
 */
function adBlockMode() {
  if (!isAdBlockActive()) return 'off';
  var flag = rd(ADBLOCK_FLAG_FILE);
  return flag === 'ads' ? 'ads' : 'full';
}

function isAdBlockActive() {
  var now = Date.now();
  if (cachedAdBlockActive !== null && (now - lastAdBlockCheck < 30000)) {
    return cachedAdBlockActive;
  }
  try {
    var hosts = fs.readFileSync('/etc/hosts', 'utf8');
    cachedAdBlockActive = hosts.indexOf(ADBLOCK_MARKER) !== -1;
    lastAdBlockCheck = now;
    return cachedAdBlockActive;
  } catch (e) {
    return false;
  }
}

function setAdBlock(mode, cb) {
  var active = isAdBlockActive();
  if (mode !== 'off') {
    var list = adBlockList(mode);
    var lines = [
      '127.0.0.1\tlocalhost.localdomain\tlocalhost',
      '::1\tlocalhost ip6-localhost ip6-loopback',
      'fe00::0\tip6-localnet',
      'ff00::0\tip6-mcastprefix',
      'ff02::1\tip6-allnodes',
      'ff02::2\tip6-allrouters',
      '',
      ADBLOCK_MARKER
    ];
    for (var i = 0; i < list.length; i++) {
      lines.push('0.0.0.0\t' + list[i]);
    }
    lines.push('');
    try {
      /*
       * Truncate and rewrite in place. The bind mount is to this file's inode,
       * so switching tier while mounted takes effect immediately - and writing
       * a new file and renaming it over this one would leave the mount showing
       * the old contents.
       */
      fs.writeFileSync(ADBLOCK_HOSTS_FILE, lines.join('\n'), 'utf8');
      fs.writeFileSync(ADBLOCK_FLAG_FILE, mode, 'utf8');
    } catch (e) {
      if (cb) cb({ ok: false, error: 'could not write adblock hosts: ' + e.message });
      return;
    }
    /*
     * Our table is already the live one, so rewriting it in place is the whole
     * change and the tier switches without a remount. Anything else mounted
     * there belongs to someone else, and a bind mount stacks on top of it.
     */
    if (active) {
      cachedAdBlockActive = null;
      cachedPrivacy = null;
      lastStats = null;
      if (cb) cb({ ok: true, enabled: true, mode: mode });
      return;
    }
    execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
      cachedAdBlockActive = null;
      cachedPrivacy = null;
      lastStats = null;
      if (cb) cb({ ok: !err, enabled: isAdBlockActive(), mode: adBlockMode() });
    });
  } else if (mode === 'off' && active) {
    try {
      if (fs.existsSync(ADBLOCK_FLAG_FILE)) fs.unlinkSync(ADBLOCK_FLAG_FILE);
    } catch (e) {}
    execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function (err) {
      cachedAdBlockActive = null;
      cachedPrivacy = null;
      lastStats = null;
      if (cb) cb({ ok: !err, enabled: isAdBlockActive(), mode: adBlockMode() });
    });
  } else {
    if (cb) cb({ ok: true, enabled: active, mode: adBlockMode() });
  }
}

/*
 * Measured on a B8 against the built-in player, watching playStateNow move:
 * KEY_PAUSE pauses, KEY_PLAY resumes, and KEY_PLAYPAUSE, KEY_PAUSECD and
 * KEY_PLAYCD do nothing at all. Pause was previously sent as KEY_PAUSECD,
 * which is why it never worked.
 *
 * Over CEC to an external box, KEY_PLAY behaves as a toggle instead.
 */
var RCU_KEY_CODES = {
  play: 207,
  pause: 119,
  stop: 128,
  fastForward: 208,
  fastforward: 208,
  rewind: 168
};

/*
 * No key toggles the built-in player, so this asks what it is doing and sends
 * the other one. An external input reports "playing" whatever the box on the
 * end is doing, and KEY_PLAY is a toggle over CEC, so that path just sends it.
 */
function sendPlayPause(cb) {
  luna('com.webos.service.acb/getForegroundAppInfo', {}, function (acb) {
    var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
    var external = !pipe || pipe.playerType === 'external input';
    var paused = !!(pipe && String(pipe.playStateNow) === 'paused');
    sendMediaKey(external || paused ? 'play' : 'pause', cb);
  });
}

function sendMediaKey(cmd, cb) {
  if (cmd === 'playPause' || cmd === 'playpause') return sendPlayPause(cb);
  var code = RCU_KEY_CODES[cmd];
  if (!code) {
    if (cb) cb(false);
    return;
  }
  injectKey(code, cb);
}

// KEY_BACK. Used to dismiss a screen saver, which consumes the first key it
// gets, so nothing behind it sees this.
var KEY_BACK = 158;

function injectKey(code, cb) {
  var fd = null;
  try {
    fd = fs.openSync('/dev/input/event1', 'w');
  } catch (e) {
    if (cb) cb(false);
    return;
  }
  function makeEv(type, c, val) {
    var b = new Buffer(16);
    b.fill(0);
    b.writeUInt16LE(type, 8);
    b.writeUInt16LE(c, 10);
    b.writeInt32LE(val, 12);
    return b;
  }
  try {
    fs.writeSync(fd, makeEv(1, code, 1), 0, 16, null);
    fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
    setTimeout(function () {
      try {
        fs.writeSync(fd, makeEv(1, code, 0), 0, 16, null);
        fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
        fs.closeSync(fd);
        if (cb) cb(true);
      } catch (e2) {
        if (cb) cb(false);
      }
    }, 50);
  } catch (e) {
    try { fs.closeSync(fd); } catch (e3) {}
    if (cb) cb(false);
  }
}

// ---------------------------------------------------------------- stats
var cachedOled = null;
var lastOledCheck = 0;

/*
 * Not every webOS set is an OLED - LCD/QNED/NanoCell models run the same
 * firmware but have no panel-hours counter, no Off-RS compensation and no
 * Pixel Refresher. Detect once and omit the whole block rather than reporting
 * a confident 0 hours, which reads as a real measurement.
 *
 * The model name decides it: every LG OLED is named "OLED...". panelUsageTime
 * is not proof - some LCD firmware answers it anyway (seen on a 2016
 * 55UH6030), which is what used to turn those sets into false OLEDs - so it
 * only gets a say when the model name is unreadable. A "panel" in config.json
 * overrides the lot.
 */
var isOled = null;   // null = not yet determined

function detectOled(cb) {
  if (isOled !== null) return cb(isOled);

  var forced = CONFIG.panel || (CONFIG.device && CONFIG.device.panel);
  if (forced) {
    isOled = /oled/i.test(forced);
    console.log('panel: ' + (isOled ? 'OLED' : 'not OLED') + ' (from config)');
    return cb(isOled);
  }
  if (fs.existsSync('/var/luna/preferences/paneltype_oled')) {
    isOled = true;
    console.log('panel: OLED (paneltype_oled present)');
    return cb(true);
  }
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['panelUsageTime', 'modelName'] },
    function (res) {
      var model = (res && res.modelName) || (CONFIG.device && CONFIG.device.model) || '';
      if (model) {
        isOled = /oled/i.test(model);
        console.log('panel: ' + (isOled ? 'OLED' : 'not OLED - panel features disabled') +
                    ' (model ' + model + ')');
        return cb(isOled);
      }
      if (res && res.panelUsageTime) {
        isOled = true;
        console.log('panel: OLED (detected via systemproperty panelUsageTime)');
        return cb(true);
      }
      // webOS 9+ (C2/G2/etc.): check pnwash filesystem records or panelcontroller service
      if (fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsLastTime') ||
          fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsTime')) {
        isOled = true;
        console.log('panel: OLED (detected via pnwash records)');
        return cb(true);
      }
      luna('com.webos.service.panelcontroller/getPanelUsageTime', { subscribe: false }, function (pcRes) {
        isOled = !!(pcRes && pcRes.panelUsageTime);
        console.log('panel: fallback to panelcontroller -> ' +
                    (isOled ? 'OLED' : 'not OLED - panel features disabled'));
        cb(isOled);
      });
    });
}

/*
 * The panel protections the service menu reaches, through the service that
 * owns them rather than the files underneath.
 *
 * com.webos.service.oledepl fronts eplmanager, which is the only thing on the
 * set that touches /mnt/lg/cmn_data/pnwash/gsrOff and its neighbours - setting
 * GSR through the service removes and recreates that file, so the two agree.
 *
 * The files are not a substitute for asking. socTpcStatus reads 0 on a C2
 * whether temporal peak control is on or off, so the old reading of it was
 * wrong whenever the setting was on. webOS 4 has no such service, and there
 * the files are all there is.
 */
/*
 * The service menu.
 *
 * factorywin shows a cut-down menu unless it is told otherwise. Its own
 * condition is
 *
 *   isSimplifiedMenuMode = !factoryMode && (!readSvcMenuFlag || isSvcMenu)
 *   isSvcMenu            = svcMenuFlag && prodkey && RELEASE && !usbAuth
 *
 * so on a retail set the only lever is svcMenuFlag, a setting in the "other"
 * category: false gives the full menu. Earlier sets do not carry the setting at
 * all - a B8 has the app and no flag - and their menu was never cut down.
 *
 * The change is read when the TV starts, so it takes a power cycle.
 *
 * Opening it is a relaunch carrying irKey, which the app turns into the key
 * event the service remote would have sent. The PIN is still asked for on the
 * TV, which is as it should be.
 */
var SERVICE_MENU_APP = 'com.webos.app.factorywin';
var SERVICE_MENUS = { ezAdjust: 1, inStart: 1 };

function serviceMenuState(cb) {
  var present = fs.existsSync('/usr/palm/applications/' + SERVICE_MENU_APP);
  luna('com.webos.settingsservice/getSystemSettings',
       { category: 'other', keys: ['svcMenuFlag'] }, function (r) {
    var flag = (r && r.returnValue === true && r.settings &&
                typeof r.settings.svcMenuFlag !== 'undefined') ? r.settings.svcMenuFlag : null;
    cb({
      ok: true,
      app: present,
      // A set without the flag has nothing to unlock, not a locked menu.
      lockable: flag !== null,
      locked: (flag === null) ? null : (flag === true),
      writable: CONFIG.allowControl
    });
  });
}

function setServiceMenuLock(locked, cb) {
  luna('com.webos.settingsservice/setSystemSettings',
       { category: 'other', settings: { svcMenuFlag: !!locked } }, function (r) {
    if (!r || r.returnValue !== true) return cb({ ok: false, error: 'the TV would not change it' });
    serviceMenuState(function (st) {
      cb({ ok: st.locked === !!locked, state: st,
           error: st.locked === !!locked ? undefined : 'the setting did not take' });
    });
  });
}

function openServiceMenu(which, cb) {
  var key = SERVICE_MENUS[which] ? which : 'ezAdjust';
  luna('com.webos.applicationManager/launch',
       { id: SERVICE_MENU_APP, params: { irKey: key } }, function (r) {
    cb({ ok: !!(r && r.returnValue), menu: key });
  });
}

var OLED_EPL = 'com.webos.service.oledepl';
var OLED_SYSPROP = 'com.webos.service.tv.systemproperty';
// null = not yet asked, false = neither service answers.
var oledProtVia = null;

function oledProtControllable() {
  return oledProtVia === 'epl' || oledProtVia === 'sysprop';
}

/*
 * webOS 4 keeps the same two protections behind a different service, with the
 * values as the strings "true" and "false" - a B8 answers getProperties for
 * OledTPC and OledGSR and has no oledepl at all. Its own service menu reads
 * them from there, which is how this was found.
 */
function readViaSysprop(cb) {
  luna(OLED_SYSPROP + '/getProperties', { keys: ['OledTPC', 'OledGSR'] }, function (r) {
    if (!r || r.returnValue !== true || typeof r.OledTPC === 'undefined') {
      oledProtVia = false;
      return cb(null);
    }
    oledProtVia = 'sysprop';
    cb({
      gsr: String(r.OledGSR) === 'true',
      tpc: String(r.OledTPC) === 'true',
      gsrStressCount: null
    });
  });
}

function readOledProtections(cb) {
  if (oledProtVia === 'sysprop') return readViaSysprop(cb);
  luna(OLED_EPL + '/getGlobalStressReduction', {}, function (gsr) {
    if (!gsr || gsr.returnValue !== true) return readViaSysprop(cb);
    luna(OLED_EPL + '/getTemporalPeakControl', {}, function (tpc) {
      oledProtVia = 'epl';
      cb({
        gsr: gsr.enable === true,
        gsrStressCount: (typeof gsr.stressCount === 'number') ? gsr.stressCount : null,
        tpc: (tpc && tpc.returnValue === true) ? tpc.enable === true : null
      });
    });
  });
}

function setOledProtection(which, enabled, cb) {
  if (which !== 'gsr' && which !== 'tpc') {
    return cb({ ok: false, error: 'unknown protection: ' + which });
  }

  function afterWrite(r) {
    lastStats = null;
    cachedOled = null;
    if (!r || r.returnValue !== true) {
      return cb({ ok: false, error: 'the TV would not change it' });
    }
    // Read it back: the call returns true whether or not anything moved.
    readOledProtections(function (state) {
      var now = state ? (which === 'gsr' ? state.gsr : state.tpc) : null;
      cb({ ok: now === !!enabled, state: state,
           error: now === !!enabled ? undefined : 'the setting did not take' });
    });
  }

  // Ask first, so a set before any read still goes to the right service.
  readOledProtections(function () {
    if (oledProtVia === 'sysprop') {
      var prop = {};
      prop[which === 'gsr' ? 'OledGSR' : 'OledTPC'] = enabled ? 'true' : 'false';
      return luna(OLED_SYSPROP + '/setProperties', prop, afterWrite);
    }
    if (oledProtVia !== 'epl') {
      return cb({ ok: false, error: 'this TV does not offer the control' });
    }
    var method = (which === 'gsr') ? 'setGlobalStressReduction' : 'setTemporalPeakControl';
    luna(OLED_EPL + '/' + method, { enable: !!enabled }, afterWrite);
  });
}

function refreshOledStats(picSettings, pState, cb) {
  var now = Date.now();
  if (cachedOled && (now - lastOledCheck < 30000)) {
    if (picSettings) {
      if (picSettings.screenShift) cachedOled.screen_shift = picSettings.screenShift;
      if (picSettings.logoLuminanceAdjust) cachedOled.logo_dimming = picSettings.logoLuminanceAdjust;
    }
    var pnStateCached = rd('/mnt/lg/cmn_data/pnwash/state');
    var jobScopeCached = rd('/mnt/lg/cmn_data/pnwash/jobScope');
    var isPnwashRunningCached = (pnStateCached && pnStateCached.indexOf('2') === 0) || (jobScopeCached === '1');
    var isCompRunningCached = isPnwashRunningCached ||
      (pState && pState.raw === 'Active Standby' && cachedOled.hours_until_comp === 0);
    cachedOled.comp_status = isCompRunningCached ? 'Running' : 'Idle';
    cachedOled.comp_status_label = isCompRunningCached ? 'Completing Panel Maintenance (Short Cycle)' : 'Idle';
    return cb(cachedOled);
  }

  /*
   * Deep Pixel Refresher ("Panel Wash") last run counter in PANEL HOURS:
   * autoPnwashTime on webOS <= 8 (B8), autoJbLastTime on webOS 9+ (C2).
   */
  var autoPnwashRaw = rd('/mnt/lg/cmn_data/pnwash/autoPnwashTime') ||
                      rd('/mnt/lg/cmn_data/pnwash/autoJbLastTime');
  var lastRefresher = autoPnwashRaw ? parseInt(autoPnwashRaw, 10) : 0;

  /*
   * Last Off-RS compensation in PANEL HOURS from the filesystem:
   * autoOffRsTime on webOS <= 8 (B8), autoOffRsLastTime on webOS 9+ (C2).
   * Confirmed on live sets: autoOffRsTime 3426 on B8; autoOffRsLastTime 4767 on C2.
   */
  var autoOffRsRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsTime') ||
                     rd('/mnt/lg/cmn_data/pnwash/autoOffRsLastTime');
  var fsLastCompHours = autoOffRsRaw ? parseInt(autoOffRsRaw, 10) : null;

  /*
   * Short Off-RS compensation interval:
   * On webOS <= 8 (B8): autoOffRsIntervalHomeMode is in 10-minute units (24 = 4h).
   * On webOS 9+ (C2): autoOffRsInterval is in whole hours (4 = 4h).
   */
  var compIntervalRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode');
  var compIntervalUnits;
  var compInterval;
  if (compIntervalRaw) {
    compIntervalUnits = parseInt(compIntervalRaw, 10);
    if (!compIntervalUnits || compIntervalUnits <= 0) compIntervalUnits = 24;
    compInterval = Math.round((compIntervalUnits * 10 / 60) * 10) / 10;
  } else {
    var compIntervalHoursRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsInterval');
    var hVal = compIntervalHoursRaw ? parseFloat(compIntervalHoursRaw) : 4;
    if (!hVal || hVal <= 0) hVal = 4;
    compInterval = hVal;
    compIntervalUnits = Math.round(hVal * 6);
  }
  if (compInterval < 0.5 || compInterval > 24) compInterval = 4;

  /*
   * Deep Pixel Refresher cadence:
   * Stored in autoJbInterval on webOS 9+ (e.g. "2000 ok"), default 2000h.
   */
  var autoJbIntervalRaw = rd('/mnt/lg/cmn_data/pnwash/autoJbInterval');
  var REFRESHER_INTERVAL_HOURS = autoJbIntervalRaw ? parseInt(autoJbIntervalRaw, 10) : 2000;
  if (!REFRESHER_INTERVAL_HOURS || REFRESHER_INTERVAL_HOURS <= 0) REFRESHER_INTERVAL_HOURS = 2000;

  function finishOledStats(usageUnits, lastCompUnits, dispRes) {
    var rawStatus = (dispRes && dispRes.status) ? dispRes.status : 'schedule';
    var statusStr = 'Idle';
    if (rawStatus === 'cancel_schedule') statusStr = 'Scheduled';
    else if (rawStatus === 'processing') statusStr = 'Running';

    // If both Luna calls returned null, fall back to filesystem Off-RS hours so OLED never shows 0
    if (usageUnits === null && fsLastCompHours !== null) {
      usageUnits = fsLastCompHours * 6;
    }

    var panelHours = (usageUnits !== null) ? Math.floor(usageUnits / 6) : 0;
    var panelHoursExact = (usageUnits !== null) ? Math.round((usageUnits * 10 / 60) * 10) / 10 : 0;

    var lastCompHours = 0;
    var hoursSinceComp = 0;
    if (lastCompUnits !== null) {
      // webOS <= 8: lastCompensationTimestamp is in 10-minute units
      lastCompHours = Math.round((lastCompUnits * 10 / 60) * 10) / 10;
      hoursSinceComp = (usageUnits !== null) ?
        Math.round(((usageUnits - lastCompUnits) * 10 / 60) * 10) / 10 : 0;
    } else if (fsLastCompHours !== null) {
      // webOS 9+: autoOffRsLastTime is in whole panel hours
      lastCompHours = fsLastCompHours;
      hoursSinceComp = (panelHoursExact && lastCompHours) ?
        Math.max(0, Math.round((panelHoursExact - lastCompHours) * 10) / 10) : 0;
    }
    var hoursUntilComp = Math.max(0, Math.round((compInterval - hoursSinceComp) * 10) / 10);

    var hoursSinceRefresher = (panelHours && lastRefresher) ? Math.max(0, panelHours - lastRefresher) : 0;
    var hoursUntilRefresher = Math.max(0, REFRESHER_INTERVAL_HOURS - hoursSinceRefresher);

    var offRsCountRaw = rd('/mnt/lg/cmn_data/pnwash/completedOffRsCount');
    var jbCountRaw = rd('/mnt/lg/cmn_data/pnwash/completedJbCount');
    var failAlertCountRaw = rd('/mnt/lg/cmn_data/pnwash/failAlertCount');
    var tpcOffExists = fs.existsSync('/mnt/lg/cmn_data/pnwash/tpcOff');
    var gsrOffExists = fs.existsSync('/mnt/lg/cmn_data/pnwash/gsrOff');
    var socTpcRaw = rd('/mnt/lg/cmn_data/pnwash/socTpcStatus');

    var offRsCycles = offRsCountRaw ? parseInt(offRsCountRaw, 10) : null;
    var jbCycles = jbCountRaw ? parseInt(jbCountRaw, 10) : null;
    var failCount = failAlertCountRaw ? parseInt(failAlertCountRaw, 10) : null;
    var hasTpcMonitoring = tpcOffExists || (socTpcRaw !== null) || fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsInterval');
    var asblStatus = hasTpcMonitoring ? ((tpcOffExists || socTpcRaw === '0') ? 'Disabled' : 'Active') : null;
    var gsrStatus = hasTpcMonitoring ? (gsrOffExists ? 'Disabled' : 'Active') : null;

    var pnStateRaw = rd('/mnt/lg/cmn_data/pnwash/state');
    var jobScopeRaw = rd('/mnt/lg/cmn_data/pnwash/jobScope');
    var isPnwashRunning = (pnStateRaw && pnStateRaw.indexOf('2') === 0) || (jobScopeRaw === '1');
    var isCompRunning = isPnwashRunning ||
      (pState && pState.raw === 'Active Standby' && hoursUntilComp === 0);
    var compStatus = isCompRunning ? 'Running' : 'Idle';
    var compStatusLabel = isCompRunning ? 'Completing Panel Maintenance (Short Cycle)' : 'Idle';

    cachedOled = {
      panel_hours: panelHours,
      panel_hours_exact: panelHoursExact,
      last_compensation_hours: lastCompHours,
      hours_since_comp: hoursSinceComp,
      hours_until_comp: hoursUntilComp,
      comp_interval_hours: compInterval,
      comp_interval_units: compIntervalUnits,
      comp_cycles: offRsCycles,
      comp_status: compStatus,
      comp_status_label: compStatusLabel,
      refresher_interval_hours: REFRESHER_INTERVAL_HOURS,
      last_refresher_hours: lastRefresher,
      hours_since_refresher: hoursSinceRefresher,
      hours_until_refresher: hoursUntilRefresher,
      refresher_cycles: jbCycles,
      refresher_status: statusStr,
      refresher_status_raw: rawStatus,
      failure_alerts: failCount,
      asbl_protection: asblStatus,
      gsr_protection: gsrStatus,
      screen_shift: (picSettings && picSettings.screenShift) ? picSettings.screenShift : 'off',
      logo_dimming: (picSettings && picSettings.logoLuminanceAdjust) ? picSettings.logoLuminanceAdjust : 'off'
    };
    lastOledCheck = Date.now();
    cb(cachedOled);
  }

  // 1. Query webOS 4-8 Luna systemproperty
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['panelUsageTime', 'lastCompensationTimestamp'] },
    function (sysRes) {
      var usageUnits = (sysRes && sysRes.panelUsageTime) ? parseInt(sysRes.panelUsageTime, 10) : null;
      var lastCompUnits = (sysRes && sysRes.lastCompensationTimestamp) ? parseInt(sysRes.lastCompensationTimestamp, 10) : null;

      function queryDisplayStatus(uUnits, cUnits) {
        // Query clearPanelNoiseStatus (webOS <= 8). On webOS 9+, service does not exist and dispRes is null.
        luna('com.webos.service.tv.display/getClearPanelNoiseStatus', {}, function (dispRes) {
          finishOledStats(uUnits, cUnits, dispRes);
        });
      }

      if (usageUnits !== null) {
        queryDisplayStatus(usageUnits, lastCompUnits);
      } else {
        // 2. webOS 9+ (C2/G2/etc.): Query com.webos.service.panelcontroller
        luna('com.webos.service.panelcontroller/getPanelUsageTime', { subscribe: false }, function (pcRes) {
          if (pcRes && pcRes.panelUsageTime) {
            usageUnits = parseInt(pcRes.panelUsageTime, 10);
          }
          queryDisplayStatus(usageUnits, lastCompUnits);
        });
      }
    }
  );
}

var prevNet = null;
/* Short server-side history of SoC temperature. The dashboard's trace would
   otherwise start empty on every load and take minutes to say anything. */
var TEMP_HISTORY_MAX = 120;
var tempHistory = [];
function pushTemp(t) {
  if (typeof t !== 'number' || isNaN(t) || t <= 0) return;   // 0 = sensor not ready
  tempHistory.push(t);
  if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
}
var lastStats = null;
var lastStatsTime = 0;
var isCollecting = false;
var statsWaiters = [];

function collectStats(cb) {
  var now = Date.now();
  // Return cached result if fresh (< 1.5 seconds old)
  if (lastStats && (now - lastStatsTime < 1500)) {
    return cb(lastStats);
  }

  // Queue callback and serialize execution
  statsWaiters.push(cb);
  if (isCollecting) return;
  isCollecting = true;

  var safetyTimeout = setTimeout(function () {
    if (isCollecting) {
      console.log('warning: stats collection safety timeout reached');
      flushStats(lastStats || { ok: false, error: 'timeout' });
    }
  }, 4500);

  function flushStats(result) {
    clearTimeout(safetyTimeout);
    lastStats = result;
    lastStatsTime = Date.now();
    isCollecting = false;
    var waiters = statsWaiters.slice(0);
    statsWaiters = [];
    for (var w = 0; w < waiters.length; w++) {
      try { waiters[w](result); } catch (e) {}
    }
  }

  var mi = meminfo();
  var status = rd('/proc/lg/pm/status') || '';
  var coreMatch = status.match(/load:\s*([\d\s]+)/);
  var coreSlots = coreMatch ? coreMatch[1].trim().split(/\s+/).map(Number) : [];
  var liveCpus = onlineCpus(status);
  var coreLoads = [];
  if (liveCpus) {
    for (var ci = 0; ci < liveCpus.length; ci++) {
      if (liveCpus[ci] < coreSlots.length) coreLoads.push(coreSlots[liveCpus[ci]]);
    }
  } else {
    coreLoads = coreSlots;
  }
  var cpuAvsMatch = status.match(/cpuavs_current\(mA\):\s*(\d+)/);
  var coreAvsMatch = status.match(/coreavs_current\(mA\):\s*(\d+)/);
  var cpuMa = cpuAvsMatch ? parseInt(cpuAvsMatch[1], 10) : null;
  var coreMa = coreAvsMatch ? parseInt(coreAvsMatch[1], 10) : null;
  var totalMa = (cpuMa !== null && coreMa !== null) ? (cpuMa + coreMa) : null;

  var n = netBytes();
  var rate = null;
  // Same interface both samples, or the delta is between two different NICs -
  // switching from Wi-Fi to ethernet would otherwise report one huge burst.
  if (n && prevNet && n.iface === prevNet.iface && n.t > prevNet.t && n.rx >= prevNet.rx) {
    var dt = (n.t - prevNet.t) / 1000;
    rate = { rx: Math.round((n.rx - prevNet.rx) / dt), tx: Math.round((n.tx - prevNet.tx) / dt) };
  }
  if (n) prevNet = n;

  var hdmiDiag = getActiveHdmiDiagnostics();
  if (hdmiDiag) {
    for (var hf in hdmiDiag) {
      if (hf !== 'port' && hdmiDiag[hf] !== null) hdmiSeen[hf] = true;
    }
  }
  var peInfo = getPictureEngineInfo();

  var out = {
    ok: true,
    time: Date.now(),
    tvwebVersion: TVWEB_VERSION,
    device: {
      id: CONFIG.device.id || 'lg_tv',
      name: CONFIG.device.name || 'LG webOS TV',
      model: CONFIG.device.model || 'webOS TV'
    },
    system: {
      webos: HARDWARE_INFO.webos,
      firmware: CONFIG.device.sw_version || null
    },
    hardware: {
      webos: HARDWARE_INFO.webos,
      soc_arch: HARDWARE_INFO.socArch,
      ram: HARDWARE_INFO.ram,
      refresh_rate: HARDWARE_INFO.refreshRate,
      eye_sensor: HARDWARE_INFO.eyeSensor
    },
    panel_silicon: HARDWARE_INFO.cell ? {
      cell: HARDWARE_INFO.cell,
      tcon_firmware: HARDWARE_INFO.tconFirmware,
      tcon_module: HARDWARE_INFO.tconModule
    } : null,
    remote: readRemoteInfo(),
    /*
     * The thermal sensor is not populated immediately after boot: for roughly
     * the first 80 seconds /proc/lg/pm/temperature reads a literal 0, which is
     * not a measurement. Reporting it would put a false 0C spike into Home
     * Assistant's history on every reboot, so treat 0 as "not ready yet".
     */
    temp: (function () {
      var t = num(rd('/proc/lg/pm/temperature'), null);
      // Anything <= 0 is the sensor not being ready, not a reading. Matches the
      // guard in pushTemp, so the reported value and the history agree.
      return (t !== null && t > 0) ? t : null;
    })(),
    temps: null,   // filled in below from the ring buffer
    /*
     * Across the whole processor, not the busiest core.
     * /proc/lg/pm/current_load is the peak: measured on a B8 it matched
     * max(cores) on every sample, so a single busy core reported the set as
     * pegged while three others idled. It is still reported, as loadPeak.
     */
    load: coreLoads.length
      ? Math.round(coreLoads.reduce(function (a, b) { return a + b; }, 0) / coreLoads.length)
      : num(rd('/proc/lg/pm/current_load'), null),
    loadPeak: coreLoads.length
      ? Math.max.apply(null, coreLoads)
      : num(rd('/proc/lg/pm/current_load'), null),
    mhz: socMhz(),
    cores: coreLoads,
    // Total slots, so the dashboard can say how many are parked rather than
    // leaving the figure count changing with no explanation.
    coresTotal: coreSlots.length,
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    swap: { total: mi.SwapTotal || 0, free: mi.SwapFree || 0, backing: swapBacking() },
    uptime: Math.floor(parseFloat(rd('/proc/uptime') || '0')),
    loadavg: (rd('/proc/loadavg') || '').split(' ').slice(0, 3),
    wifi: wifi(),
    net: rate,
    /*
     * Cumulative counters for the interface the rate came from, so the two
     * always describe the same link. Kernel counters, so they reset at boot
     * and start from zero on whichever interface is in use - Wi-Fi or wired.
     */
    netTotal: n ? { rx: n.rx, tx: n.tx, iface: n.iface } : null,
    mac: n ? macAddress(n.iface) : null,
    emmc: emmcInfo(),
    signal: getVideoSignal(),
    hdmi_diag: hdmiDiag,
    picture_engine: peInfo,
    colorimetry: peInfo ? peInfo.colorimetry : null,
    power: {
      cpu_ma: cpuMa,
      core_ma: coreMa,
      current_ma: totalMa
    },
    inputs: inputNameMap
  };

  pushTemp(out.temp);   // pushTemp already ignores non-numbers
  out.temps = tempHistory.slice();

  // Refresh input names if cache expired
  refreshInputNames();

  // Chained Luna queries: power -> sound -> soundSettings -> foregroundApp -> picture settings -> apps
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    out.powerState = mapPowerState(pw && pw.state);
    out.screenSaver = isScreenSaver(out.powerState);
    out.screensaverMode = screensaverMode();
    out.screensaverLevel = screensaverLevel();
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'time', keys: ['sleepTimer'] }, 30000, function (tm) {
    out.sleepTimer = (tm && tm.settings && tm.settings.sleepTimer) || 'off';
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'option', keys: ['standByLight', 'logoLight', 'powerOnLight'] }, 60000, function (op) {
    var os = (op && op.settings) || {};
    out.lights = {
      standby: os.standByLight === 'on',
      logo: os.logoLight === 'on',
      powerOn: os.powerOnLight === 'on',
      hasLogo: hasLogoLight === true
    };
    out.gpuMhz = gpuClockMhz();
  lunaCached('com.palm.connectionmanager/getStatus', {}, 60000, function (cm) {
    // Network name, so the Wi-Fi figures say which network they refer to.
    var w = cm && cm.wifi;
    out.ssid = (w && w.ssid) ? w.ssid : null;
  lunaCached('com.webos.service.tv.display/getDimmingStatus', {}, 15000, function (dim) {
    // ABL / logo dimming activity. OLED only in practice.
    out.dimming = (dim && dim.status) || null;
  lunaCached('com.webos.service.tv.display/getLightSensorData', {}, 30000, function (ls) {
    /*
     * Ambient light sensor. Not every set has one: a model without it still
     * answers, reporting 65535 (0xFFFF) for every channel. Treat that as
     * absent rather than publishing a nonsense lux figure.
     */
    var lux = null, sd = (ls && ls.sensorData) || [];
    for (var li = 0; li < sd.length; li++) {
      if (sd[li].property === 'visibleLuminance' || sd[li].property === 'luminance') {
        if (sd[li].value !== 65535 && sd[li].value !== null) lux = sd[li].value;
      }
    }
    out.lightSensor = (lux === null) ? null : { lux: lux };
    if (out.lightSensor) hasLightSensor = true;
    out.backlight = (ls && typeof ls.backlightValue === 'number') ? ls.backlightValue : null;
  appStorage(function (st) {
    out.appStorage = st;
  lunaCached('com.webos.audio/getSoundOut', {}, 10000, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      /*
       * The audio scenario names the output the way the audio service does -
       * "mastervolume_headphone" - which is an internal identifier, not a
       * reading. The prefix is the volume domain, and the rest is the same
       * output name the sound setting uses.
       */
      out.audio_output = sound.scenario ?
        formatSoundOutput(String(sound.scenario).replace(/^mastervolume_/, '')) : 'Internal';
    }
    lunaCached('com.webos.service.settings/getSystemSettings',
      { category: 'sound', keys: ['soundOutput', 'soundMode'] }, 15000,
      function (snd) {
        var rawSnd = (snd && snd.settings && snd.settings.soundOutput) ? snd.settings.soundOutput : (sound && sound.scenario ? sound.scenario : 'tv_speaker');
        out.sound = {
          output: formatSoundOutput(rawSnd),
          output_raw: rawSnd,
          mode: (snd && snd.settings && snd.settings.soundMode) || 'standard'
        };
        /*
         * The TV's own media pipeline. applicationManager says which app is in
         * front; this says what that app's player is doing.
         *
         * It describes the TV, not the source: with an external input it reads
         * "playing" for as long as the HDMI pipeline is up, whatever the box on
         * the other end is doing. Useful for the built-in apps, not a transport
         * state for anything on HDMI.
         */
        lunaCached('com.webos.service.acb/getForegroundAppInfo', {}, 4000, function (acb) {
        var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
        if (pipe && pipe.playStateNow) {
          out.media = {
            state: String(pipe.playStateNow),
            playerType: pipe.playerType || null,
            fullScreen: pipe.isFullScreen !== false
          };
          hasMediaState = true;
        }
        lunaCached('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (app) {
          if (app && app.appId) {
            var shortApp = String(app.appId).replace('com.webos.app.', '');
            out.app = shortApp;
            out.app_id = app.appId;
            out.app_name = inputNameMap[shortApp] || shortApp;
            out.display_title = (inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp) ?
              (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : shortApp;
          }
          lunaCached('com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: ['backlight', 'pictureMode', 'energySaving', 'screenShift', 'logoLuminanceAdjust'] },
            10000, function (pic) {
              if (pic && pic.settings) {
                var rawDr = (pic.dimension && pic.dimension.dynamicRange) ? pic.dimension.dynamicRange : 'sdr';
                out.picture = {
                  dynamicRange: formatDynamicRange(rawDr),
                  mode: formatPicMode(pic.settings.pictureMode),
                  mode_raw: pic.settings.pictureMode || 'standard',
                  backlight: num(pic.settings.backlight, 50),
                  energySaving: pic.settings.energySaving || 'off',
                  screenShift: pic.settings.screenShift || 'off',
                  logoLuminanceAdjust: pic.settings.logoLuminanceAdjust || 'off',
                  modes: []
                };
              }
              pictureModes(function (modes) {
              if (out.picture) out.picture.modes = modes;
              refreshInstalledApps(function (apps) {
                out.apps = apps || [];
                out.privacy = {
                  adblock: {
                    enabled: isAdBlockActive(),
                    count: ADBLOCK_DOMAINS.length
                  }
                };
                detectOled(function (oledPanel) {
                  /* webOS 3.x exposes no thermal sensor at all: the file simply
                     does not exist, /sys/class/thermal is empty and there is no
                     hwmon. That is different from the ~80s post-boot window where
                     the file exists but reads 0, so report it as a capability and
                     let the UI say "none" rather than imply a pending reading. */
                  out.capabilities = { oled: oledPanel, thermal: THERMAL_PRESENT,
                                       emmcWear: EMMC_WEAR_PRESENT };
                  if (!oledPanel) {
                    out.oled = null;
                    return flushStats(out);
                  }
                  refreshOledStats((pic && pic.settings) ? pic.settings : null, out.powerState, function (oled) {
                    out.oled = oled;
                    flushStats(out);
                  });
                });
              });
              });
            }
          );
        });
        });
      }
    );
  });
  });   // close appStorage
  });   // close connectionmanager
  });   // close light sensor
  });   // close dimming
  });   // close option settings
  });   // close time settings
  });   // close getPowerState
}

// ---------------------------------------------------------------- processes
/*
 * Read-only process list, loaded on demand rather than folded into the
 * telemetry payload - it answers "what is using the memory" when someone
 * looks, and there is no reason to publish it to MQTT every ten seconds.
 *
 * Deliberately no kill action. Closing a stuck app is what closeByAppId is
 * for, which lets the app manager tear down cleanly; most of these respawn
 * anyway, and surface-manager is the compositor.
 */
/*
 * A readable name for a process, from its argv.
 *
 * comm is not enough: the kernel caps it at 15 characters, so every LG app
 * arrived as "com.webos.app.i" whatever it really was.
 *
 * WebAppMgr needs more than a basename. It is webOS's Chromium, and Chromium
 * runs one process per role from a single binary - so a TV with four web apps
 * warm shows five identical rows called WebAppMgr, which reads as something
 * gone wrong rather than as the browser doing its job. The role is in --type,
 * absent for the browser process itself, and a renderer that loads an app's
 * V8 snapshot names the app in the path.
 */
function procName(comm, args) {
  var bin = String(args).split(/\s+/)[0].replace(/^.*\//, '');

  if (bin === 'WebAppMgr') {
    var app = args.match(/\/usr\/palm\/applications\/([^\/\s]+)/);
    if (app) return 'WebAppMgr (' + app[1].replace(/^com\.webos\.app\./, '') + ')';
    var type = args.match(/--type=(\w+)/);
    return 'WebAppMgr (' + (type ? type[1] : 'browser') + ')';
  }

  /*
   * Neither field is reliable on its own. comm is the name the process chose,
   * but the kernel caps it at 15 characters. argv[0] is complete but is
   * sometimes not a name at all - the broadcast service runs
   * /mnt/lg/lgapp/RELEASE and calls itself tvservice.
   *
   * So: comm unless it is exactly at the cap, which is what a clipped name
   * looks like, and then argv[0] to recover the rest of it.
   */
  return (comm && comm.length < 15) ? comm : (bin || comm);
}

/*
 * CPU per process, over a short window.
 *
 * `ps -o pcpu` on this busybox reports the average since the process started,
 * so anything that worked hard at boot reads high forever - systemd sits at
 * 2.4% on an idle set. The only way to say what is busy now is to read the
 * counters twice and take the difference.
 *
 * Percentages are of the whole machine rather than of one core, so they can be
 * compared with the CPU figure on the Metrics tab and add up to roughly it. A
 * process pegging one core of three reads 33%, not 100%.
 */
var CPU_WINDOW_MS = 700;

function sampleCpuTicks() {
  var out = { total: 0, procs: {} };
  try {
    var cpu = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    for (var i = 1; i < cpu.length; i++) out.total += parseInt(cpu[i], 10) || 0;
  } catch (e) {
    return null;
  }
  var names;
  try { names = fs.readdirSync('/proc'); } catch (e2) { return null; }
  for (var n = 0; n < names.length; n++) {
    if (!/^\d+$/.test(names[n])) continue;
    try {
      var raw = fs.readFileSync('/proc/' + names[n] + '/stat', 'utf8');
      /*
       * The command sits in brackets and may itself contain a bracket or a
       * space, so the fields are counted from the last one rather than by
       * splitting the line. After it the first field is the state, which is
       * the third overall - utime and stime are the fourteenth and fifteenth.
       */
      var close = raw.lastIndexOf(')');
      if (close < 0) continue;
      var f = raw.slice(close + 2).split(' ');
      out.procs[names[n]] = {
        ticks: (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0),
        comm: raw.slice(raw.indexOf('(') + 1, close)
      };
    } catch (e3) {}
  }
  return out;
}

/*
 * The whole command line, the way `ps -o args` gives it - procName needs more
 * than argv[0], since a web app is named by the application path further along
 * it. Kernel threads have none, and return empty.
 */
function procCmdline(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')
             .replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch (e) {
    return '';
  }
}

function collectCpuProcesses(cb, retried) {
  var first = sampleCpuTicks();
  if (!first) return cb({ ok: false, error: 'could not read /proc' });

  setTimeout(function () {
    var second = sampleCpuTicks();
    if (!second) return cb({ ok: false, error: 'could not read /proc' });

    var elapsed = second.total - first.total;
    /*
     * Seen once, immediately after a restart, and not reproduced since: the
     * counters read the same twice, which leaves nothing to divide by. Take
     * one more window rather than handing back an error for something that
     * clears itself.
     */
    if (elapsed <= 0) {
      if (retried) return cb({ ok: false, error: 'the CPU counters did not move' });
      return collectCpuProcesses(cb, true);
    }

    var rows = [], busy = 0;
    for (var pid in second.procs) {
      if (!second.procs.hasOwnProperty(pid)) continue;
      var was = first.procs[pid];
      // A process that started inside the window has nothing to compare
      // against, so its whole total would read as if spent in it.
      if (!was) continue;
      var delta = second.procs[pid].ticks - was.ticks;
      if (delta <= 0) continue;
      var pct = delta / elapsed * 100;
      busy += pct;
      rows.push({ name: procName(second.procs[pid].comm, procCmdline(pid)), pct: Math.round(pct * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.pct - a.pct; });
    cb({
      ok: true,
      windowMs: CPU_WINDOW_MS,
      busy: Math.round(busy * 10) / 10,
      active: rows.length,
      top: rows.slice(0, 10)
    });
  }, CPU_WINDOW_MS);
}

function collectProcesses(cb) {
  execFile('/bin/ps', ['-eo', 'rss,comm,args'], { timeout: 4000, maxBuffer: 1024 * 1024 }, function (err, stdout) {
    if (err) return cb({ ok: false, error: 'could not read process list' });
    var lines = String(stdout || '').split('\n'), rows = [], total = 0, count = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/);
      if (!m) continue;
      var rss = parseInt(m[1], 10);
      count++;
      total += rss;
      rows.push({ name: procName(m[2], m[3]), mb: Math.round(rss / 1024 * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.mb - a.mb; });
    cb({
      ok: true,
      count: count,
      totalMb: Math.round(total / 1024),
      top: rows.slice(0, 10)
    });
  });
}

// ---------------------------------------------------------------- hdmi / misc
/*
 * GPU clock. /proc/lg/sys/status carries the PLL outputs in Hz.
 */
function gpuClockMhz() {
  var raw = rd('/proc/lg/sys/status');
  if (!raw) return null;
  var m = raw.match(/gpu pll out\s*:\s*(\d+)/i);
  return m ? Math.round(parseInt(m[1], 10) / 1000000) : null;
}

/*
 * Whether the screen saver is on screen right now. The same file already read
 * for the GPU clock carries it as "ss: OFF".
 *
 * There has been a control to start one since #24 but no way to see whether
 * it took: turnOnScreenSaver returns true whether or not anything answered the
 * request, so the only honest confirmation is the set saying so itself.
 *
 * A set that does not publish the field reports nothing rather than "off",
 * which would claim a screen saver is not running on a TV that never says.
 */


/*
 * App storage. Separate partition from cmn_data, and the one that actually
 * fills up and makes installs fail.
 */
var cachedAppStorage = null;
var lastAppStorageCheck = 0;
var APP_STORAGE_TTL = 60000;

function appStorage(cb) {
  var now = Date.now();
  if (cachedAppStorage && (now - lastAppStorageCheck < APP_STORAGE_TTL)) {
    return cb(cachedAppStorage);
  }
  execFile('/bin/df', ['-k', '/mnt/lg/appstore'], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(cachedAppStorage || null);
    var lines = String(stdout || '').trim().split('\n');
    var f = (lines[lines.length - 1] || '').split(/\s+/);
    if (f.length < 4) return cb(cachedAppStorage || null);
    var total = parseInt(f[1], 10), used = parseInt(f[2], 10), avail = parseInt(f[3], 10);
    if (!total) return cb(cachedAppStorage || null);
    cachedAppStorage = {
      totalMb: Math.round(total / 1024),
      usedMb: Math.round(used / 1024),
      freeMb: Math.round(avail / 1024),
      pct: Math.round(used / total * 100)
    };
    lastAppStorageCheck = Date.now();
    cb(cachedAppStorage);
  });
}

/*
 * HDMI PHY state, straight off the receiver. Loaded on demand rather than in
 * telemetry: four ports of timing detail is a lot to publish every ten seconds
 * and it only matters when someone is looking at it.
 *
 * The PHY nodes are port0..port3 while the TV numbers its inputs HDMI 1..4,
 * and the obvious port+1 mapping is wrong: on a set whose only live input is
 * HDMI 2 (eim reports activate/chosen true, a CEC device present, everything
 * else empty) the port carrying signal is port2, not port1. There is no
 * hotplug or EDID field to pin the rest of the mapping down, so this does not
 * guess. Ports are reported as-is, and the input the TV says is active is
 * matched to the one port carrying signal when exactly one of each exists.
 */
function hdmiPorts() {
  var ports = [];
  for (var i = 0; i < 4; i++) {
    var raw = rd('/proc/lg/hdmi20/port' + i + '/status');
    if (!raw) continue;
    function f(re) { var m = raw.match(re); return m ? m[1].trim() : null; }
    var hact = parseInt(f(/horizontal-active:\s*(\d+)/) || '0', 10);
    var vact = parseInt(f(/vertical-active:\s*(\d+)/) || '0', 10);
    var rate = parseInt(f(/pixel-clock-V:\s*(\d+)/) || '0', 10);
    var pclk = parseInt(f(/pixel-clock:\s*(\d+)/) || '0', 10);

    // Format 2 (webOS 9+ / HDMI 2.1 driver): Sig:[3840](4400)x[2160](2250)@[120]Hz
    if (!hact || !vact) {
      var sigM = raw.match(/Sig:\s*\[(\d+)\](?:\(\d+\))?x\[(\d+)\](?:\(\d+\))?@\[(\d+)\]\s*Hz/i);
      if (sigM) {
        hact = parseInt(sigM[1], 10);
        vact = parseInt(sigM[2], 10);
        if (!rate) rate = parseInt(sigM[3], 10);
      }
    }
    if (!pclk) {
      var pclkStr = f(/Pixel Clk\[0*([1-9]\d*)\]/i);
      if (pclkStr) {
        var pclkNum = parseInt(pclkStr, 10);
        pclk = (pclkNum < 100000) ? pclkNum * 10 : Math.round(pclkNum / 1000);
      }
    }
    var isConnected = /connected:\s*on/i.test(raw) ||
                      /PHY\s+Lock\[1\]/i.test(raw) ||
                      (hact > 0 && vact > 0);
    var colorDepth = f(/deep-color-mode:\s*(\S+ \S+)/) || f(/DeepColorMode\[\s*([^\]]+)\]/);
    if (colorDepth) colorDepth = colorDepth.replace(/^[.\s]+/, '');
    var isInterlaced = /interlaced:\s*yes/i.test(raw) || /Interlaced\[1\]/i.test(raw);

    ports.push({
      port: i,
      connected: isConnected,
      resolution: (isConnected && hact && vact) ? (hact + 'x' + vact) : null,
      refreshHz: (isConnected && rate) ? rate : null,
      pixelClockMhz: (isConnected && pclk) ? Math.round(pclk / 1000 * 10) / 10 : null,
      colorDepth: isConnected ? colorDepth : null,
      interlaced: isConnected ? isInterlaced : false
    });
  }
  return ports;
}

/*
 * Inputs as the TV describes them, with the live PHY figures attached to the
 * active one. The labels are the TV's own, so a renamed input reads "Apple TV"
 * rather than a port number this code guessed at.
 */
function hdmiInputs(cb) {
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    var devs = (res && res.devices) || [];
    var ports = hdmiPorts();
    var signalling = [];
    for (var p = 0; p < ports.length; p++) if (ports[p].connected) signalling.push(ports[p]);

    var inputs = [];
    var activeIdx = -1;
    for (var d = 0; d < devs.length; d++) {
      if (!devs[d].id || String(devs[d].id).indexOf('HDMI') !== 0) continue;
      if (devs[d].activate) activeIdx = inputs.length;
      // On webOS <= 8, lastUniqueId 255 means nothing ever identified over CEC.
      // On webOS 9+, lastUniqueId is -1 when empty.
      var hasCec = devs[d].lastUniqueId !== undefined &&
                   devs[d].lastUniqueId !== 255 &&
                   devs[d].lastUniqueId !== -1;
      var seen = !!(hasCec || devs[d].hdmiPlugIn || devs[d].connected || (devs[d].subCount > 0));
      inputs.push({
        id: devs[d].id,
        port: devs[d].port,
        label: devs[d].label || devs[d].id,
        appId: devs[d].appId,
        active: !!devs[d].activate,
        deviceSeen: seen,
        signal: null
      });
    }
    // Only claim a pairing when it is unambiguous.
    if (activeIdx !== -1 && signalling.length === 1) {
      inputs[activeIdx].signal = signalling[0];
    }
    cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: (activeIdx !== -1 && signalling.length === 1) });
  });
}

// ---------------------------------------------------------------- privacy
/*
 * View of LG's data collection, and the changes the platform offers an API
 * for.
 *
 * The consent flags are mirrored into /var/luna/preferences/eula, but
 * com.webos.settingsservice owns them: it regenerates that file at boot, which
 * is why editing the file looks like it works and reverts. Reads come from the
 * file because it costs no fork; writes go through the service.
 *
 * The other actions here are genuine Luna calls, not file edits: rotating the
 * advertising identifier and clearing ad cookies.
 *
 * Labels are deliberately plain. "ACR" and "LMT" mean nothing to most people,
 * so the UI is given a description for every row rather than an acronym.
 */

// Only flags whose meaning is actually known are described. Anything else is
// surfaced under its raw name rather than given an invented explanation.
var CONSENT_LABELS = {
  acrAllowed:              ['Screen content recognition', 'Lets LG identify what is on your screen to profile your viewing'],
  acrGdprAllowed:          ['Screen recognition (GDPR consent)', 'The EU consent record for screen content recognition'],
  acrAdAllowed:            ['Ads based on what you watch', 'Uses recognised screen content to target advertising'],
  customAdAllowed:         ['Personalised advertising', 'Tailors the ads shown on your TV to you'],
  customadsAllowed:        ['Personalised advertising (secondary flag)', 'A second personalised-advertising consent record'],
  cookiesAllowed:          ['Advertising cookies', 'Stores cookies used for ad tracking'],
  thirdPartySharingAllowed:['Sharing your data with other companies', 'Passes your usage data to third parties'],
  additionalDataAllowed:   ['Additional usage data', 'Extra analytics beyond what the TV needs to work'],
  remoteDiagAllowed:       ['Remote diagnostics upload', 'Lets LG collect and upload diagnostic reports from your TV'],
  voiceAllowed:            ['Voice recordings', 'Allows voice data to be collected and processed'],
  voice2Allowed:           ['Voice recordings (secondary flag)', 'A second voice-data consent record']
};

/*
 * Never offered as toggles.
 *
 * The first three record acceptance of the terms and of network use rather
 * than a collection choice, and what a set does when they are false is
 * untested. allAllowed is the Select-All: whether writing it cascades to the
 * other twenty is also untested, and a single click that silently grants
 * everything is the one failure this panel must not have.
 */
var CONSENT_LOCKED = {
  generalTermsAllowed: 'Acceptance of the terms themselves.',
  networkAllowed:      'Acceptance of network use.',
  firstUseAllowed:     'Part of first-boot setup.',
  allAllowed:          'The Select-All. Read-only because whether writing it cascades to the ' +
                       'other flags is untested.'
};

/*
 * /var/palm/license/eulaInfoNetwork.json maps each flag to the licence
 * documents accepting it implies. The mapping is firmware-specific - chpAllowed
 * names S_CHP on a C8 and only S_SVC on this B8 - so it is read from the set
 * rather than hardcoded.
 *
 * It is what separates an undescribed flag the TV can at least account for from
 * one it cannot. Flags in no group get no toggle: nobody can consent to
 * something neither we nor the platform can name.
 */
var consentGroups = null;
var consentMapFound = false;

function loadConsentGroups() {
  if (consentGroups) return consentGroups;
  consentGroups = {};
  try {
    var j = JSON.parse(rd('/var/palm/license/eulaInfoNetwork.json') || '{}');
    var list = (j.eulaMappingList && j.eulaMappingList.eulaInfo) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.settingKey) continue;
      // "mandatory" is the set that actually has to be accepted; the notice and
      // select-all entries are the same document on every group.
      consentGroups[e.settingKey] = (e.mandatory || e.generalSelectAll || []).slice().sort();
      consentMapFound = true;
    }
  } catch (err) { /* no mapping on this set: every unlabelled flag stays read-only */ }
  return consentGroups;
}

/*
 * The agreement documents behind the flags, read from the settings service.
 *
 * eulaStatus is the output: a C8 on 4.4.0 rebuilds every flag from the accepted
 * documents at boot, so a flag written on its own reverts there. A B8 on 4.4.3
 * does not rebuild, which is why writing flags alone appeared to work and left
 * the two records disagreeing. Writing both keeps them saying the same thing on
 * either firmware. Reported in #61.
 *
 * It also carries the titles - "S_ADG" is "Viewing Information Agreement" -
 * which is the only place on the set that names them. The file that caches this
 * does not exist on webOS 9, so it is read from the service.
 */
function readConsentDocs(cb) {
  luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, function (r) {
    var eln = r && r.settings && r.settings.eulaInfoNetwork;
    cb(eln && Array.isArray(eln.eulaList) ? eln : null);
  });
}

function acceptedSet(eln) {
  var out = {};
  for (var i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].accepted) out[eln.eulaList[i].id] = true;
  }
  return out;
}

function docsSatisfied(need, accepted) {
  for (var i = 0; i < need.length; i++) if (!accepted[need[i]]) return false;
  return need.length > 0;
}

/*
 * What the TV would hold after this change. The documents move first and every
 * mapped flag is then derived from them, which is exactly what the rebuilding
 * firmware does at boot - done here so both firmwares agree immediately.
 *
 * A document needed by a flag that cannot be switched off is never withdrawn:
 * Terms of Use sits under nearly every group, and dropping it would withdraw
 * the lot.
 */
function planConsent(key, on, flags, eln) {
  var groups = loadConsentGroups();
  var accepted = acceptedSet(eln);
  var need = groups[key] || [];
  var i, k;

  if (on) {
    for (i = 0; i < need.length; i++) accepted[need[i]] = true;
  } else {
    var protectedDocs = {};
    for (k in groups) {
      if (!groups.hasOwnProperty(k)) continue;
      if (!CONSENT_LOCKED[k] || !flags[k]) continue;
      for (i = 0; i < groups[k].length; i++) protectedDocs[groups[k][i]] = true;
    }
    for (i = 0; i < need.length; i++) {
      if (!protectedDocs[need[i]]) delete accepted[need[i]];
    }
  }

  var nextFlags = {}, changed = [];
  for (k in flags) if (flags.hasOwnProperty(k)) nextFlags[k] = flags[k];
  for (k in groups) {
    if (!groups.hasOwnProperty(k) || !nextFlags.hasOwnProperty(k)) continue;
    if (CONSENT_LOCKED[k]) continue;
    /*
     * Downward only. A flag whose agreement has just been withdrawn has to go
     * off with it, but nothing is ever switched on as a side effect: a set
     * whose flags were written directly before this existed has documents
     * saying yes under flags saying no, and reconciling that upwards would
     * turn collection back on behind the reader.
     */
    if (nextFlags[k] && !docsSatisfied(groups[k], accepted)) {
      nextFlags[k] = false;
      changed.push(k);
    }
  }
  if (nextFlags[key] !== on) { nextFlags[key] = on; if (changed.indexOf(key) === -1) changed.push(key); }

  var nextDocs = JSON.parse(JSON.stringify(eln));
  for (i = 0; i < nextDocs.eulaList.length; i++) {
    nextDocs.eulaList[i].accepted = !!accepted[nextDocs.eulaList[i].id];
  }
  return { flags: nextFlags, docs: nextDocs, changed: changed };
}

/*
 * Name the documents a row depends on, and the rows that move with it. A flag
 * cannot be off while an agreement it shares is accepted, so the panel says so
 * before the click rather than surprising the reader afterwards.
 */
function annotateConsent(consent, eln) {
  if (!consent || !eln) return;
  var titles = {}, i;
  for (i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].title) titles[eln.eulaList[i].id] = eln.eulaList[i].title;
  }
  var groups = loadConsentGroups();
  var rows = (consent.known || []).concat(consent.other || []);
  var flags = {}, byKey = {};
  for (i = 0; i < rows.length; i++) { flags[rows[i].key] = rows[i].enabled; byKey[rows[i].key] = rows[i]; }

  for (i = 0; i < rows.length; i++) {
    var row = rows[i], need = groups[row.key];
    if (!need) continue;
    var names = [];
    for (var j = 0; j < need.length; j++) if (titles[need[j]]) names.push(titles[need[j]]);
    if (names.length) {
      row.agreements = names;
      // Now that the documents can be named, an undescribed flag can say what
      // it is filed under instead of that the TV would not say.
      if (!CONSENT_LABELS[row.key]) {
        row.detail = 'Accepted under ' + (names.length > 1
          ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
          : names[0]) + '.';
      }
    }
    if (!row.settable || !row.enabled) continue;
    var plan = planConsent(row.key, false, flags, eln);
    var also = [];
    for (var c = 0; c < plan.changed.length; c++) {
      var k = plan.changed[c];
      if (k === row.key || !byKey[k]) continue;
      also.push(byKey[k].label || k);
    }
    if (also.length) row.sharesWith = also;
  }
}

function consentSettable(key) {
  if (CONSENT_LOCKED[key]) return false;
  if (CONSENT_LABELS[key]) return true;
  return !!loadConsentGroups()[key];
}

// Every labelled flag accepting exactly the same documents. That is the only
// honest description available for a flag LG never published one for, and
// naming just the first of several would pick one arbitrarily.
function consentPeers(key, groups) {
  var mine = groups[key], names = [];
  if (!mine || !mine.length) return names;
  for (var other in groups) {
    if (!groups.hasOwnProperty(other) || other === key) continue;
    if (!CONSENT_LABELS[other]) continue;
    if (groups[other].join(',') === mine.join(',')) names.push('"' + CONSENT_LABELS[other][0] + '"');
  }
  return names;
}

/*
 * Display grouping. 21 flat rows is a list nobody reads to the end of, and the
 * groups put the flags LG never described in one place instead of scattering
 * them between ones that are explained.
 */
var CONSENT_GROUPS = [
  ['advertising', 'Advertising'],
  ['watching',    'What the TV watches and hears'],
  ['analytics',   'Analytics and sharing'],
  ['services',    'LG services'],
  ['unknown',     'No published description',
   'The TV records these and LG publishes nothing about what they mean. ' +
   'The ones it cannot tie to any agreement are left read-only.'],
  ['platform',    'Set on the TV itself',
   'Acceptance records rather than collection choices. Changed in the TV\'s own menus, ' +
   'under Settings \u203a General \u203a About This TV \u203a User Agreements.']
];

var CONSENT_GROUP_OF = {
  customAdAllowed: 'advertising',
  customadsAllowed: 'advertising',
  cookiesAllowed: 'advertising',
  acrAdAllowed: 'advertising',

  acrAllowed: 'watching',
  acrGdprAllowed: 'watching',
  voiceAllowed: 'watching',
  voice2Allowed: 'watching',

  additionalDataAllowed: 'analytics',
  remoteDiagAllowed: 'analytics',
  thirdPartySharingAllowed: 'analytics',

  /*
   * Named in CONSENT_NAMES, so they belong with their subject rather than
   * under "no published description" - a row titled "LG Channels" filed as
   * undescribed reads as an oversight. acrOn accepts the same agreement as
   * third-party sharing; marketing has its own; chp and shopping are LG
   * offerings a viewer opts into.
   */
  acrOnAllowed: 'watching',
  marketingOnAllowed: 'advertising',
  chpAllowed: 'services',
  shoppingOnAllowed: 'services',

  // Read-only, and structural rather than a collection choice.
  networkAllowed: 'platform',
  generalTermsAllowed: 'platform',
  firstUseAllowed: 'platform',
  allAllowed: 'platform'
};

function consentGroup(key) {
  return CONSENT_GROUP_OF[key] || 'unknown';
}

/*
 * A name only, for flags LG publishes no description of. Deliberately separate
 * from CONSENT_LABELS: a label there means "we can say what this collects",
 * which is what makes a flag settable. Naming a row must never be what decides
 * that - a title is not an understanding of what it grants.
 *
 * Names from #61, read off the licence documents each flag accepts on a C8.
 * The descriptions offered alongside them are not taken: they assert firmware-
 * specific findings (and, for generalTermsAllowed, an untested outcome) that do
 * not hold on 4.4.3. What a flag is grouped with is derived at runtime instead.
 */
var CONSENT_NAMES = {
  networkAllowed:      'Network use',
  /* webOS 9 only, and named after the TV's own eulaGroupName for each. */
  marketingOnAllowed:  'Marketing',
  shoppingOnAllowed:   'Shopping',
  generalTermsAllowed: 'Terms of Use and Privacy Policy',
  chpAllowed:          'LG Channels',
  acrOnAllowed:        'Screen recognition (master consent)',
  allAllowed:          'Select All'
};

/*
 * Daemons worth naming, with what they do and how the platform runs them.
 *
 * "bus" ones are started on demand by ls-hubd: asking them anything starts
 * them, this panel's own getAdid call included, so whether the process exists
 * says nothing about whether the TV chose to run it. "upstart" ones are
 * supervised jobs whose running state is real, and which initctl can hold down.
 */
var PRIVACY_DAEMONS = {
  acr2:       ['Content recognition service', 'Identifies what is on screen', 'bus'],
  admanager:  ['Advertising service', 'Fetches and displays ads on the TV', 'bus'],
  uploadd:    ['Diagnostics uploader', 'Sends diagnostic data to LG', 'upstart'],
  rdxd:       ['Diagnostics collector', 'Gathers crash and diagnostic reports', 'upstart']
};

/*
 * Held down across reboots by the boot hook, which reads this file. Only jobs
 * upstart supervises can be held down at all - the bus starts the others back
 * up the moment anything asks them a question.
 */
var SERVICES_FILE = '/var/lib/tvweb/services_stopped';
var SERVICE_CONTROLLABLE = { uploadd: true, rdxd: true };

function stoppedServices() {
  var raw = rd(SERVICES_FILE), out = [];
  if (!raw) return out;
  var parts = raw.split('\n');
  for (var i = 0; i < parts.length; i++) {
    var n = parts[i].replace(/\s+/g, '');
    if (n && SERVICE_CONTROLLABLE[n] && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

/*
 * Upstart's view, or nothing. webOS 9 keeps an initctl that lists no jobs at
 * all - on a C2 it answers `touch: /tmp/rdxd: Read-only file system` - so the
 * set gets no toggles there, which is the right answer: uploadd and rdxd run,
 * but not as jobs anything here can hold down.
 */
function upstartJobs(cb) {
  execFile('/sbin/initctl', ['list'], { timeout: 4000 }, function (err, stdout) {
    var out = {}, lines = String(stdout || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\S+)\s+(\S+)/.exec(lines[i]);
      if (m) out[m[1]] = m[2].replace(/,$/, '');   // "start/running, process 123"
    }
    cb(out);
  });
}

function setServiceEnabled(name, enable, cb) {
  execFile('/sbin/initctl', [enable ? 'start' : 'stop', name], { timeout: 6000 }, function () {
    // initctl reports failure when the job is already in the state asked for,
    // so the job's own state decides, not the exit code.
    upstartJobs(function (jobs) {
      var running = String(jobs[name] || '').indexOf('start/') === 0;
      var list = stoppedServices(), at = list.indexOf(name);
      if (enable && at !== -1) list.splice(at, 1);
      if (!enable && at === -1) list.push(name);
      try {
        if (list.length) fs.writeFileSync(SERVICES_FILE, list.join('\n') + '\n', 'utf8');
        else if (fs.existsSync(SERVICES_FILE)) fs.unlinkSync(SERVICES_FILE);
      } catch (e) { /* the job moved either way; only the boot hook loses out */ }
      cachedPrivacy = null;
      console.log('service: ' + name + ' -> ' + (enable ? 'start' : 'stop') +
                  (running === enable ? '' : ' (did not take)'));
      cb(running === enable
        ? { ok: true, name: name, running: running }
        : { ok: false, error: 'the TV did not ' + (enable ? 'start' : 'stop') + ' ' + name });
    });
  });
}

/*
 * Power state. tvpower reports the panel separately from the system: a set can
 * be "Active" with the screen lit, or "ScreenOff" with the system running and
 * the panel blanked - which is exactly what the Screen Off control does. The
 * dashboard previously showed neither, so blanking the panel changed nothing
 * on screen and the source kept reading as though something were displayed.
 */
var POWER_STATES = {
  'active':        ['On', true,  true],
  'screenoff':     ['Screen off', true,  false],
  'activestandby': ['Standby', false, false],
  'suspend':       ['Standby', false, false],
  'poweroff':      ['Off', false, false],
  'prepared':      ['Starting up', true, false],
  // tvpower reports a running screen saver as a power state of its own.
  'screensaver':   ['Screen Saver', true,  true]
};

/*
 * Whether a screen saver is on screen. tvpower reports it as a power state of
 * its own, which is the only source that tracks it: the foreground app does
 * not change - the screen saver draws over whatever is running - and the
 * running-apps list keeps the screen saver app long after it has gone.
 *
 * Measured on a B8: "Screen Saver" while one draws, "Active" once a key
 * dismisses it.
 */
function isScreenSaver(ps) {
  return !!(ps && String(ps.raw || '').toLowerCase().replace(/[\s_-]/g, '') === 'screensaver');
}

function mapPowerState(raw) {
  var key = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  var m = POWER_STATES[key];
  if (m) return { raw: raw, label: m[0], systemOn: m[1], screenOn: m[2] };
  // Unknown state: report it verbatim rather than guessing at a friendly name.
  return { raw: raw || null, label: raw || 'Unknown', systemOn: true, screenOn: true };
}

var cachedPrivacy = null, lastPrivacyCheck = 0;

/*
 * A flag with no published description. What can be said about it comes from
 * the licence mapping, and whether it can be changed follows from the same
 * place - see loadConsentGroups.
 */
function describeUnlabelled(key, on, groups) {
  var row = { key: key, enabled: on, settable: consentSettable(key), group: consentGroup(key) };
  if (CONSENT_NAMES[key]) row.label = CONSENT_NAMES[key];
  var docs = groups[key];
  /*
   * The document ids (S_ADG and friends) go in the payload but never on the
   * page: LG publishes no index for them, and this TV carries no file that
   * resolves one to a title, so on screen they are noise wearing the costume
   * of an explanation.
   */
  if (docs) row.documents = docs;
  if (CONSENT_LOCKED[key]) {
    row.detail = CONSENT_LOCKED[key];
    return row;
  }
  if (!docs) {
    row.detail = consentMapFound
      ? 'Tied to no agreement on this firmware.'
      : 'This TV publishes no agreement mapping, so there is nothing to go on.';
    return row;
  }
  var peers = consentPeers(key, groups);
  row.detail = peers.length
    ? 'Accepted under the same agreement as ' + peers.join(' and ') + '.'
    : 'Filed under an agreement the TV does not name.';
  return row;
}

function readConsentFlags() {
  var raw = rd('/var/luna/preferences/eula');
  if (!raw) return null;
  var groups = loadConsentGroups();
  var out = { known: [], other: [] };
  var re = /"([a-zA-Z0-9_]+Allowed)"\s*:\s*(true|false)/g, m;
  while ((m = re.exec(raw)) !== null) {
    var key = m[1], on = m[2] === 'true';
    if (CONSENT_LABELS[key]) {
      out.known.push({ key: key, label: CONSENT_LABELS[key][0], detail: CONSENT_LABELS[key][1],
                       enabled: on, settable: consentSettable(key),
                       group: consentGroup(key) });
    } else {
      out.other.push(describeUnlabelled(key, on, groups));
    }
  }
  return out;
}

function runningDaemons(cb) {
  var held = stoppedServices();
  upstartJobs(function (jobs) {
    execFile('/bin/ps', ['-eo', 'args'], { timeout: 4000 }, function (err, stdout) {
      var txt = String(stdout || ''), list = [];
      for (var name in PRIVACY_DAEMONS) {
        if (!PRIVACY_DAEMONS.hasOwnProperty(name)) continue;
        var d = PRIVACY_DAEMONS[name];
        var onDemand = d[2] === 'bus';
        list.push({
          name: name,
          label: d[0],
          detail: d[1],
          running: txt.indexOf('/usr/sbin/' + name) !== -1,
          onDemand: onDemand,
          job: jobs[name] || null,
          stoppable: !onDemand && !!SERVICE_CONTROLLABLE[name] && !!jobs[name],
          heldDown: held.indexOf(name) !== -1
        });
      }
      cb(list);
    });
  });
}

function collectPrivacy(cb) {
  var now = Date.now();
  if (cachedPrivacy && (now - lastPrivacyCheck < 20000)) return cb(cachedPrivacy);

  var out = { ok: true, consent: readConsentFlags(), consentWritable: CONFIG.allowControl,
              consentGroups: CONSENT_GROUPS };

  /*
   * Scan first. Every luna call below starts the service it asks, so a scan
   * afterwards can only ever report acr2 and admanager as running - which is
   * what this panel did, on every load, for as long as it has existed.
   */
  runningDaemons(function (daemons) {
    out.daemons = daemons;
    // Titles and the sharing map come from the same record the writes move, so
    // the rest of the payload waits on it rather than racing it.
    lunaCached('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, 60000,
               function (elnRes) {
    var eln = elnRes && elnRes.settings && elnRes.settings.eulaInfoNetwork;
    if (eln && Array.isArray(eln.eulaList)) annotateConsent(out.consent, eln);
    luna('com.webos.service.acr/getACRSolutionStatus', {}, function (acr) {
      // `false` here means the recognition engine is not running at all.
      out.acr = {
        label: 'Screen content recognition',
        detail: 'LG calls this ACR. It samples what is on screen to work out what you are watching.',
        active: !!(acr && acr.ACRSolutionStatus)
      };
      luna('com.webos.service.acr/getVideoCaptureStatus', {}, function (cap) {
        out.acr.capturing = !!(cap && cap.status && cap.status !== 'stopped');
        out.acr.captureState = (cap && cap.status) ? cap.status : 'unknown';
        luna('com.webos.service.admanager/getAdid', {}, function (ad) {
          /*
           * getAdid does not exist on every firmware - a C8 on 4.4.0 answers
           * `Unknown method`, a B8 on 4.4.3 answers properly. Without this the
           * failure renders as "no identifier assigned", which is a claim about
           * the TV rather than about the call.
           */
          var adOk = !!(ad && ad.returnValue !== false && ad.IFA !== undefined);
          var id = (adOk && ad.IFA) ? String(ad.IFA) : null;
          out.advertisingId = {
            available: adOk,
            label: 'Advertising identifier',
            detail: 'A unique ID your TV hands to advertisers. Resetting it breaks the link to your past activity.',
            /*
             * The value is deliberately NOT returned, not even truncated. It is
             * an identifier for this household, and the dashboard is the sort of
             * thing that ends up in screenshots. Whether a reset worked is
             * reported by the reset action itself, which compares before and
             * after on the TV without either value leaving it.
             */
            present: !!id,
            limitTracking: !!(ad && String(ad.LMT).toLowerCase() === 'on'),
            limitTrackingLabel: 'Limit ad tracking',
            limitTrackingDetail: 'When on, apps are asked not to use this ID to profile you.'
          };
          out.adblock = {
            enabled: isAdBlockActive(),
            mode: adBlockMode(),
            count: adBlockList('full').length,
            adCount: ADBLOCK_ADS.length,
            platform: adBlockPlatform()
          };
          cachedPrivacy = out;
          lastPrivacyCheck = Date.now();
          cb(out);
        });
      });
    });
    });
  });
}

// ---------------------------------------------------------------- controls
var INPUTS = { hdmi1: 1, hdmi2: 1, hdmi3: 1, hdmi4: 1, livetv: 1 };

// Verified against the settings service: 15 is rejected, 10 and 90 are not.
// Set from collectStats: sets without the hardware report 65535 and get null.
var hasLightSensor = false;

/*
 * Which HDMI diagnostics this set reports, one flag per field.
 *
 * Latched rather than read live, because hdmi_diag is absent whenever no HDMI
 * source is active - on the Home screen, on Live TV, on an app - and that is
 * not the same as the set being unable to report it. Once seen, the entity
 * stays; a field the set never reports never gets one.
 *
 * Per field because the block is not all or nothing. An HDMI 2.0 port reports
 * as connected and fills in none of the 2.1 lines, so asking only whether the
 * block existed gave a B8 six entities it could never answer.
 */
var hdmiSeen = {};

/*
 * Whether this set reports a media play state at all. com.webos.service.acb
 * does not exist on webOS 9 - a C2 answers "Service does not exist" - so the
 * sensor there could only ever read unknown. Latched like the HDMI fields,
 * because the service also returns nothing when no pipeline is running, which
 * is not the same as the service being absent.
 */
var hasMediaState = false;


/*
 * Screen savers.
 *
 * The platform's screen saver is a plain QML app on both firmwares, sitting on
 * a read-only overlay, so a replacement is bind-mounted over it the same way
 * the ad blocker stacks a hosts file. LG's own appinfo.json is copied across
 * rather than written from scratch: it carries the window type and per-model
 * flags, and only `main` needs to resolve to our QML, which it does once the
 * directory underneath it is ours.
 *
 * The marker file inside the mount is what "which screen saver is running" is
 * read from - the live mount answers that, a stored preference only says what
 * was asked for.
 */
var SCREENSAVER_APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';
var SCREENSAVER_DIR = '/var/lib/tvweb/screensaver';
var SCREENSAVER_MARKER = '.tvweb-screensaver';
var SCREENSAVER_LEVEL_MARKER = '.tvweb-brightness';

// Read from the mount rather than from a stored preference, for the same
// reason the mode is: the file that is actually staged is the answer.
function screensaverLevel() {
  try {
    var v = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_LEVEL_MARKER), 'utf8').trim();
    if (v === 'bright') return 'bright';
  } catch (e) {}
  return 'dim';
}

var SCREENSAVERS = {
  stock: {
    label: 'LG default',
    description: 'The screen saver the TV shipped with.'
  },
  clock: {
    label: 'Clock',
    description: 'A digital clock on black, moving to a new position every minute.',
    qml: 'screensavers/clock.qml'
  },
  starfield: {
    label: 'Starfield',
    description: 'A drifting cosmic starscape with occasional shooting stars.',
    qml: 'screensavers/starfield.qml'
  },
  fireworks: {
    label: 'Fireworks',
    description: 'Bursts of colour on black, a few seconds apart.',
    qml: 'screensavers/fireworks.qml'
  },
  vitals: {
    label: 'Panel vitals',
    description: "The set's own readings - panel hours, pixel refresher countdown, temperature.",
    qml: 'screensavers/vitals.qml'
  }
};

function screensaverMode() {
  try {
    var m = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER), 'utf8').trim();
    if (SCREENSAVERS[m] && m !== 'stock') return m;
  } catch (e) {}
  return 'stock';
}

function screensaverList() {
  var cur = screensaverMode();
  var out = [];
  for (var k in SCREENSAVERS) {
    out.push({
      id: k,
      label: SCREENSAVERS[k].label,
      description: SCREENSAVERS[k].description,
      active: k === cur,
      available: k === 'stock' || !!assetPath(SCREENSAVERS[k].qml)
    });
  }
  return { ok: true, current: cur, level: screensaverLevel(),
           modes: out, writable: CONFIG.allowControl };
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

/*
 * Unmount first, always. The stock appinfo.json has to be read from the real
 * app directory, and while a replacement is mounted that is exactly what is
 * hidden.
 */
function setScreensaver(mode, level, cb) {
  if (!SCREENSAVERS[mode]) return cb({ ok: false, error: 'unknown screen saver: ' + mode });
  level = (level === 'bright') ? 'bright' : 'dim';

  execFile('/bin/umount', [SCREENSAVER_APP_DIR], { timeout: 4000 }, function () {
    if (mode === 'stock') {
      lastStats = null;
      return restartScreensaverApp(function () {
        cb({ ok: screensaverMode() === 'stock', current: screensaverMode(), level: screensaverLevel() });
      });
    }

    var src = assetPath(SCREENSAVERS[mode].qml);
    if (!src) return cb({ ok: false, error: 'screen saver asset missing: ' + SCREENSAVERS[mode].qml });

    try {
      mkdirp(path.join(SCREENSAVER_DIR, 'qml'));
      fs.writeFileSync(path.join(SCREENSAVER_DIR, 'appinfo.json'),
                       fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json')));
      writeScreensaverQml(src, level);
      fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), mode);
    } catch (e) {
      return cb({ ok: false, error: 'could not stage the screen saver: ' + e.message });
    }

    execFile('/bin/mount', ['--bind', SCREENSAVER_DIR, SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      lastStats = null;
      restartScreensaverApp(function () {
        var now = screensaverMode();
        cb({ ok: !err && now === mode, current: now, level: screensaverLevel(),
             error: (!err && now === mode) ? undefined : 'the mount did not take' });
      });
    });
  });
}

/*
 * The QML is read once at launch, so a screen saver already running is still
 * the old one and has to go before the swap means anything.
 *
 * One that is on screen is dismissed with a key rather than closed outright.
 * tvpower hands a screen saver request to a client and waits to be answered,
 * and killing the client mid-handshake leaves the service waiting on a process
 * that no longer exists: every later request is then refused as busy until the
 * set is power cycled. A key press lets it finish and exit on its own terms.
 */
/*
 * The vitals screen saver reads /api/stats from the server on this TV. The
 * port is configurable and the API refuses an unauthenticated read when a
 * token is set, so the address is written in here rather than guessed by the
 * QML.
 */
function writeScreensaverQml(src, level) {
  var qml = fs.readFileSync(src, 'utf8')
    .replace(/__TVWEB_URL__/g,
      'http://127.0.0.1:' + (CONFIG.port || 8080) + '/api/stats' +
      (CONFIG.token ? '?k=' + encodeURIComponent(CONFIG.token) : ''))
    // How bright to draw. The screen saver decides what that means for its own
    // palette; this only says which of the two was asked for.
    .replace(/__TVWEB_LEVEL__/g, level === 'bright' ? '1' : '0');
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', 'main.qml'), qml);

  /*
   * Anything else in the screen saver folder goes with it. The starfield draws
   * its points from an image, and the mount replaces the whole app directory,
   * so a file left behind in assets is a file the QML cannot open.
   */
  try {
    var from = path.dirname(src);
    var files = fs.readdirSync(from);
    for (var i = 0; i < files.length; i++) {
      if (/\.qml$/i.test(files[i])) continue;
      fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', files[i]),
                       fs.readFileSync(path.join(from, files[i])));
    }
  } catch (e) {
    console.error('screensaver: could not stage its files: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER), level === 'bright' ? 'bright' : 'dim');
}

/*
 * The mount points at a directory, and what was staged into it stays there
 * across reboots - so an upgrade that ships a corrected screen saver would
 * otherwise never reach the TV until someone picked the mode again. Rewriting
 * the file in place needs no unmount and no restart: the next screen saver to
 * launch reads it.
 */
function restageScreensaver() {
  var mode = screensaverMode();
  if (mode === 'stock') return;
  var src = assetPath(SCREENSAVERS[mode].qml);
  if (!src) return;
  try {
    var staged = path.join(SCREENSAVER_DIR, 'qml', 'main.qml');
    var before = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : '';
    writeScreensaverQml(src, screensaverLevel());
    if (fs.readFileSync(staged, 'utf8') !== before) {
      console.log('screensaver: restaged "' + mode + '" from a newer asset');
    }
  } catch (e) {
    console.error('screensaver: could not restage ' + mode + ': ' + e.message);
  }
}

function restartScreensaverApp(cb) {
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (!isScreenSaver(mapPowerState(pw && pw.state))) {
      // Nothing drawing, so nothing is mid-handshake and the app - idle or
      // absent - can be closed so the next launch reads the new QML.
      return luna('com.webos.applicationManager/closeByAppId',
                  { id: 'com.webos.app.screensaver' }, function () { cb(); });
    }
    injectKey(KEY_BACK, function () {
      setTimeout(function () {
        luna('com.webos.applicationManager/closeByAppId', { id: 'com.webos.app.screensaver' }, function () {
          // It was on screen when the swap happened, so put the new one up in
          // its place rather than leaving the set on whatever was behind it.
          setTimeout(function () {
            luna('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function () { cb(); });
          }, 1500);
        });
      }, 1500);
    });
  });
}

/*
 * Front-panel lights. The "option" settings category carries standByLight,
 * logoLight and powerOnLight on every set, whether or not the hardware is
 * fitted - tv.model.logoLight is the capability flag, and reads false on a
 * B8, which has only a standby LED. Ask the model, not the setting.
 */
var hasLogoLight = null;   // null = not yet determined

function detectLogoLight(cb) {
  if (hasLogoLight !== null) return cb(hasLogoLight);
  luna('com.webos.service.config/getConfigs',
    { configNames: ['tv.model.logoLight'] },
    function (res) {
      var v = res && res.configs && res.configs['tv.model.logoLight'];
      // Absent means the model does not declare it; treat that as no hardware.
      hasLogoLight = (v === true);
      console.log('front lights: standby LED' + (hasLogoLight ? ' + logo light' : ' only (no logo light on this model)'));
      cb(hasLogoLight);
    });
}

/*
 * Remote navigation. Sent through the network input service rather than written
 * to /dev/input: it is a service call, and the TV accepts it whatever is in the
 * foreground.
 *
 * Arrows and enter are the standard evdev codes. Back is LG's own - 412, the
 * IR_KEY_BACK in /usr/share/X11/xkb/keycodes/lg less the 8 that xkb adds - and
 * measured on a C2 it is the one that acts; evdev's 158 is taken as a dismissal
 * rather than a step back. The service refuses anything above about 512, which
 * rules out the rest of LG's table, and no code was found for Home at all, so
 * that launches the home app instead.
 */
var RCU_KEYS = {
  up: 103,
  down: 108,
  left: 105,
  right: 106,
  ok: 28,
  back: 412
};

var SLEEP_TIMER_VALUES = ['off', '10', '30', '60', '90', '120'];

// What the settings service accepts for logoLuminanceAdjust, per
// getSystemSettingValues on a B8. "strong" is the strongest, not an on/off.
var LOGO_DIMMING_VALUES = ['off', 'light', 'strong'];

function doControl(action, value, cb) {
  if (!CONFIG.allowControl) return cb({ ok: false, error: 'controls disabled in config' });

  var origCb = cb;
  cb = function (r) {
    if (r && r.ok) { lastStats = null; clearLunaCache(); }
    origCb(r);
  };

  switch (action) {
    case 'volume':
      return luna('com.webos.audio/setVolume',
                  { volume: Math.max(0, Math.min(100, num(value, 10))) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'volumeStep':
      var step = num(value, 1);
      if (step === 1) {
        return luna('com.webos.audio/volumeUp', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      if (step === -1) {
        return luna('com.webos.audio/volumeDown', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      return luna('com.webos.audio/getVolume', {}, function (cur) {
        var curVol = (cur && typeof cur.volume === 'number') ? cur.volume : 10;
        var target = Math.max(0, Math.min(100, curVol + step));
        luna('com.webos.audio/setVolume', { volume: target }, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'mute':
      var shouldMute = (value === 'true' || value === true || value === 'ON' || value === '1' || value === 1);
      return luna('com.webos.audio/setMuted',
                  { muted: shouldMute },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOff':   // OLED: blank the panel, keep audio playing
      return luna('com.webos.service.tvpower/power/turnOffScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOn':
      return luna('com.webos.service.tvpower/power/turnOnScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'input':
      if (!INPUTS[value]) return cb({ ok: false, error: 'unknown input' });
      return luna('com.webos.applicationManager/launch',
                  { id: 'com.webos.app.' + value },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'launch_app':
    case 'launchApp':
      var appId = String(value || '').trim();
      if (!appId) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/launch', { id: appId }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'close_app':
    case 'closeApp':
      var appIdToClose = String(value || '').trim();
      if (!appIdToClose) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/closeByAppId', { id: appIdToClose }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'picture_mode':
    case 'pictureMode':
      var pMode = String(value || '').trim();
      if (!pMode) return cb({ ok: false, error: 'missing picture mode' });
      return luna('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode'] }, function (cur) {
        var pPayload = { category: 'picture', settings: { pictureMode: pMode } };
        if (cur && cur.dimension) pPayload.dimension = cur.dimension;
        luna('com.webos.service.settings/setSystemSettings', pPayload, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'sound_output':
    case 'soundOutput':
      var sOut = String(value || '').trim();
      if (!sOut) return cb({ ok: false, error: 'missing sound output' });
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'sound', settings: { soundOutput: sOut } },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'playback':
    case 'media':
      return sendMediaKey(value, function (ok) {
        cb({ ok: ok });
      });

    /*
     * Two tiers: "ads" blocks the ad and telemetry hosts, "full" takes LG's
     * store and update endpoints with them. Callers that predate the choice
     * pass a boolean and still mean off/full.
     */
    case 'adblock':
    case 'setAdBlock':
    case 'toggleAdBlock':
      var abMode = String(value == null ? '' : value).toLowerCase();
      if (action === 'toggleAdBlock' || abMode === 'toggle') {
        abMode = isAdBlockActive() ? 'off' : 'full';
      } else if (abMode !== 'off' && abMode !== 'ads' && abMode !== 'full') {
        abMode = (value === true || abMode === 'on' || abMode === 'true' || abMode === '1')
          ? 'full' : 'off';
      }
      return setAdBlock(abMode, function (res) { cb(res); });

    /*
     * Rotate the advertising identifier. A real Luna call, not a file edit -
     * this is the same reset the TV's own menus perform.
     */
    case 'resetAdId':
      // Read before and after so the UI can say whether it actually changed,
      // without either identifier being sent anywhere.
      return luna('com.webos.service.admanager/getAdid', {}, function (before) {
        var was = (before && before.IFA) ? String(before.IFA) : null;
        luna('com.webos.service.admanager/resetIFA', {}, function (r) {
          luna('com.webos.service.admanager/getAdid', {}, function (after) {
            var now = (after && after.IFA) ? String(after.IFA) : null;
            cachedPrivacy = null;
            cb({
              ok: !!(r && r.returnValue !== false),
              changed: !!(was && now && was !== now)
            });
          });
        });
      });

    /*
     * Flip one consent flag. The setter replaces the whole eulaStatus object,
     * so the current one is read back immediately before writing rather than
     * reused from cache - the TV's own menus change these too.
     */
    case 'consent':
      var ckey = (value && value.key) ? String(value.key) : '';
      var cOn = !!(value && (value.enabled === true || value.enabled === 'true'));
      if (!ckey) return cb({ ok: false, error: 'no consent flag named' });
      if (!consentSettable(ckey)) return cb({ ok: false, error: ckey + ' is not changeable from here' });
      return luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (r) {
        var cur = r && r.settings && r.settings.eulaStatus;
        if (!cur || typeof cur !== 'object') return cb({ ok: false, error: 'could not read the consent flags' });
        if (!cur.hasOwnProperty(ckey)) return cb({ ok: false, error: 'no such consent flag: ' + ckey });

        readConsentDocs(function (eln) {
          if (!eln) return cb({ ok: false, error: 'could not read the agreement documents' });
          var plan = planConsent(ckey, cOn, cur, eln);
          if (!plan.changed.length) {
            cachedPrivacy = null;
            return cb({ ok: true, key: ckey, enabled: cOn, changed: false });
          }
          luna('com.webos.settingsservice/setSystemSettings',
               { settings: { eulaInfoNetwork: plan.docs, eulaStatus: plan.flags } }, function (w) {
            cachedPrivacy = null;
            if (!(w && w.returnValue)) {
              console.log('consent: ' + ckey + ' -> ' + cOn + ' (refused)');
              return cb({ ok: false, error: (w && w.errorText) || 'the TV refused the change' });
            }
            /*
             * Read back. returnValue means the service took the call, not that
             * it stored anything - writing the file directly looks exactly as
             * successful and reverts at boot.
             */
            luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (v) {
              var now = v && v.settings && v.settings.eulaStatus;
              var applied = !!(now && now[ckey] === cOn);
              console.log('consent: ' + ckey + ' ' + cur[ckey] + ' -> ' + cOn +
                          (plan.changed.length > 1 ? ' (with ' + (plan.changed.length - 1) + ' sharing the agreement)' : '') +
                          (applied ? '' : ' (accepted but not applied)'));
              cb(applied
                ? { ok: true, key: ckey, enabled: cOn, changed: true, alsoChanged: plan.changed.length - 1 }
                : { ok: false, error: 'the TV accepted the change without applying it' });
            });
          });
        });
      });

    case 'clearAdCookies':
      return luna('com.webos.service.admanager/inactivateCookies', {}, function (r) {
        cachedPrivacy = null;
        cb({ ok: !!(r && r.returnValue !== false) });
      });

    /*
     * Sleep timer. Accepted values are off, 10, 30, 60, 90, 120 - 15 is
     * rejected by the settings service despite being an obvious guess.
     */
    case 'sleepTimer':
      var st = String(value == null ? 'off' : value).trim();
      if (SLEEP_TIMER_VALUES.indexOf(st) === -1) {
        return cb({ ok: false, error: 'sleep timer must be one of ' + SLEEP_TIMER_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'time', settings: { sleepTimer: st } },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    // Front panel LEDs. Both live in the "option" category.
    /*
     * Both live in the picture category and are OLED panel protections, not
     * picture settings: screenShift takes on/off, logoLuminanceAdjust takes
     * off/light/strong. The settings service publishes the accepted values
     * through getSystemSettingValues, and a rejected one returns false rather
     * than erroring, so an unsupported value simply does not take.
     */
    case 'screenShift':
      var shiftOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { screenShift: shiftOn ? 'on' : 'off' } },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'logoDimming':
      var logoVal = String(value || '').trim().toLowerCase();
      if (LOGO_DIMMING_VALUES.indexOf(logoVal) === -1) {
        return cb({ ok: false, error: 'logo dimming takes ' + LOGO_DIMMING_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { logoLuminanceAdjust: logoVal } },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'standbyLight':
    case 'logoLight':
      var lightKey = (action === 'standbyLight') ? 'standByLight' : 'logoLight';
      var lightOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var lightPayload = { category: 'option', settings: {} };
      lightPayload.settings[lightKey] = lightOn ? 'on' : 'off';
      return luna('com.webos.service.settings/setSystemSettings', lightPayload,
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'serviceMenuLock':
      return setServiceMenuLock(!!(value && value.locked), cb);

    case 'serviceMenuOpen':
      return openServiceMenu(String((value && value.menu) || 'ezAdjust'), cb);

    case 'oledProtection':
      var prot = (value && typeof value === 'object') ? value : {};
      return setOledProtection(String(prot.key || ''), !!prot.enabled, cb);

    case 'rcu':
      var rcuName = String(value || '').trim().toLowerCase();
      if (rcuName === 'home') {
        // No keycode reaches the home screen - the service rejects LG's own -
        // so ask the application manager for it directly.
        return luna('com.webos.applicationManager/launch', { id: 'com.webos.app.home' },
                    function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });
      }
      if (!RCU_KEYS.hasOwnProperty(rcuName)) {
        return cb({ ok: false, error: 'unknown key: ' + rcuName });
      }
      return luna('com.webos.service.networkinput/test/sendKeyCode',
                  { keyCode: RCU_KEYS[rcuName] },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'screensaverMode':
      /*
       * The mode and how brightly to draw it are staged together: both are
       * written into the same file, so setting one without the other would
       * quietly reset it.
       */
      var ssMode = value, ssLevel = screensaverLevel();
      if (value && typeof value === 'object') {
        ssMode = value.mode;
        if (value.level) ssLevel = value.level;
      }
      return setScreensaver(String(ssMode || '').trim(), ssLevel, function (r) {
        lastStats = null;
        cb(r);
      });

    case 'screensaver':
      /*
       * One control for both directions. Nothing turns a screen saver off -
       * tvpower publishes turnOnScreenSaver and the registerScreenSaverRequest
       * pair, and no more - so it is dismissed the way the remote does it, with
       * a key press the screen saver consumes before anything behind it sees.
       */
      return luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
        if (isScreenSaver(mapPowerState(pw && pw.state))) {
          return injectKey(KEY_BACK, function (ok) {
            lastStats = null;
            cb(ok ? { ok: true } : { ok: false, error: 'could not reach the remote input device' });
          });
        }
        /*
         * turnOnScreenSaver does not draw anything itself. tvpower asks whatever
         * has registered a screen saver request to show one, and returns true
         * whether or not anything answers. An HDMI input or Live TV registers
         * nothing, because the screen saver exists to protect the panel from a
         * static image, not to interrupt video. So on those sources the call
         * reports success and nothing happens; say so instead.
         */
        luna('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
          var fgId = (fg && fg.appId) ? String(fg.appId).replace('com.webos.app.', '') : '';
          if (/^hdmi[1-4]$/.test(fgId) || fgId === 'livetv') {
            return cb({ ok: false, error: 'the screen saver is only available from an app, not from ' + fgId });
          }
          luna('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function (r) {
            lastStats = null;
            if (r && r.returnValue) return cb({ ok: true });
            /*
             * tvpower refuses in more places than the two guarded above - a
             * webOS 9 set turns it down on its own home screen with "Invalid
             * State change Request". Which contexts allow it is the TV's to
             * decide, so pass its answer along rather than guessing at a list.
             */
            cb({ ok: false, error: (r && r.errorText)
              ? 'the TV would not start a screen saver here: ' + r.errorText
              : 'the TV would not start a screen saver from ' + (fgId || 'this source') });
          });
        });
      });

    case 'toast':
      /* Both the payload's sourceId and luna-send's -a have to name an app the
         bus already knows; "tvweb" is rejected as an Unknown Source. */
      return luna('com.webos.notification/createToast',
                  { sourceId: TOAST_SOURCE, message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue), error: r && r.errorText }); },
                  TOAST_SOURCE);

    case 'powerOff':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      return luna('com.webos.service.tvpower/power/powerOff', { reason: 'remoteKey' },
                  function (r) {
                    if (r && r.returnValue) return cb({ ok: true });
                    luna('com.webos.service.tvpower/power/powerOff', { reason: 'localKey' }, function (r2) {
                      cb({ ok: !!(r2 && r2.returnValue), error: (r2 && r2.errorText) || (r && r.errorText) });
                    });
                  });

    /*
     * Reboot deliberately does NOT go through tvpower.
     *
     * On webOS 4.4.3, luna://com.webos.service.tvpower/power/reboot accepts
     * the request and reports success, but the kernel never restarts: the set
     * drops off the network for about a minute and comes back with its uptime
     * still climbing. Measured on an OLED65B8SLC - 12810s before the call,
     * 12871s after. It behaves like a standby transition, not a reboot, so the
     * button was reporting success while doing something else entirely.
     *
     * /sbin/reboot performs a real orderly restart (verified: uptime reset to
     * 60s, services and the webosbrew boot hook all came back cleanly).
     *
     * Reply first - this process is about to go down with the system.
     */
    case 'reboot':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      cb({ ok: true, note: 'rebooting' });
      return setTimeout(function () {
        execFile('/bin/sh', ['-c', 'sync; /sbin/reboot'], function () {});
      }, 400);

    case 'refresherSchedule':
      return luna('com.webos.service.tv.display/requestClearPanelNoise', { mode: 'schedule' },
                  function (r) {
                    lastOledCheck = 0;
                    lastStats = null;
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'refresherCancel':
      return luna('com.webos.service.tv.display/requestClearPanelNoise', { mode: 'cancel_schedule' },
                  function (r) {
                    lastOledCheck = 0;
                    lastStats = null;
                    cb({ ok: !!(r && r.returnValue) });
                  });

    default:
      return cb({ ok: false, error: 'unknown action' });
  }
}

// ------------------------------------------------------- external assets
/*
 * The UI is authored as a real HTML file (assets/ui.html) rather than a JS
 * string array, so it can be edited and diffed like a web page.
 *
 * A second complete dashboard used to live here as a fallback for a missing
 * asset. Nothing kept the two in step and it drifted two rewrites behind -
 * different readouts, its own copy of the render logic, no version footer -
 * so the working dashboard it promised was a misleading one, and an install
 * broken in a way nobody would notice. Now a missing asset says so.
 */
var WEB_ENABLED = !(CONFIG.web && CONFIG.web.enabled === false);

var ASSET_DIRS = [
  path.join(__dirname, 'assets'),
  '/var/lib/tvweb/assets'
];

function assetPath(rel) {
  // Reject traversal before touching the filesystem.
  if (rel.indexOf('\0') !== -1) return null;
  var clean = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  if (clean.indexOf('..') !== -1) return null;
  for (var i = 0; i < ASSET_DIRS.length; i++) {
    var full = path.join(ASSET_DIRS[i], clean);
    if (full.indexOf(ASSET_DIRS[i]) !== 0) continue;   // outside the root
    try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; }
    catch (e) {}
  }
  return null;
}

/*
 * Shown in place of the dashboard when its asset is missing. Deliberately
 * plain and self-contained: it names what is absent and where it was looked
 * for, because the fix is a redeploy and the reader needs to know that rather
 * than be shown numbers. The API and the MQTT bridge are unaffected, so it
 * says that too before anyone assumes the whole server is down.
 */
function missingAssetsPage() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>LG webOS TV &middot; dashboard assets missing</title>',
    '<style>',
    'body{background:#000;color:rgba(255,255,255,.8);margin:0;padding:8vw 6vw;',
    '  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'h1{font-size:19px;font-weight:500;color:#fff;margin:0 0 18px}',
    'p{margin:0 0 14px;max-width:62ch}',
    'code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:3px;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}',
    'ul{margin:0 0 14px;padding-left:20px}',
    '.dim{color:rgba(255,255,255,.5);font-size:13px}',
    '</style></head><body>',
    '<h1>Dashboard assets are missing</h1>',
    '<p><code>ui.html</code> was not found. The server is running normally &mdash;',
    'the JSON API and the Home Assistant MQTT bridge are unaffected &mdash; but it',
    'has no dashboard to serve.</p>',
    '<p>Looked in:</p><ul>',
    ASSET_DIRS.map(function (d) {
      return '<li><code>' + d.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></li>';
    }).join(''),
    '</ul>',
    '<p>Deploying again restores it: <code>./server/deploy.sh &lt;tv-ip&gt;</code>.</p>',
    '<p class="dim">tvweb ' + TVWEB_VERSION + '</p>',
    '</body></html>'
  ].join('\n');
}

var UI_HTML = null;
var UI_HTML_GZ = null;
var ASSET_CACHE = {};

(function loadUI() {
  if (!WEB_ENABLED) return;   // nothing will serve it
  var f = assetPath('ui.html');
  if (!f) {
    console.error('assets: ui.html not found in ' + ASSET_DIRS.join(', ') +
                  ' - the dashboard will report it is missing');
    return;
  }
  try {
    UI_HTML = fs.readFileSync(f, 'utf8');
    console.log('assets: serving ui.html from ' + f);
    zlib.gzip(UI_HTML, function (err, gzipped) {
      if (!err && gzipped) {
        UI_HTML_GZ = gzipped;
        console.log('assets: pre-compressed ui.html (' + UI_HTML.length + ' -> ' + gzipped.length + ' bytes)');
      }
    });
  } catch (e) {
    console.error('assets: could not read ui.html: ' + e.message);
  }
})();

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

// ---------------------------------------------------------------- server
function send(res, code, body, type) {
  /*
   * No Access-Control-Allow-Origin. The telemetry includes what is currently
   * playing, the model, panel hours and usage, and a wildcard here let any
   * site the user happened to visit read all of it from their browser. The
   * dashboard is same-origin, so it needs no CORS grant.
   */
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

/*
 * Settings the dashboard is allowed to write. Everything else in config.json
 * (port, host, allowControl, allowPower, token) stays file-only: those decide
 * who may reach this server at all, and a UI that can widen its own exposure
 * defeats the point of setting them.
 */
function readConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('warning: could not re-read ' + CONFIG_FILE + ': ' + e.message);
  }
  return {};
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

/*
 * A topic segment ends up in every topic this bridge publishes. MQTT wildcards
 * and a trailing slash would produce topics Home Assistant silently never
 * matches, which looks like a broken bridge rather than a bad prefix.
 */
function badTopic(v) {
  return !v || /[#+\s]/.test(v) || v.charAt(0) === '/' || v.charAt(v.length - 1) === '/';
}

function validateSettings(j) {
  var m = (j && j.mqtt) || {};
  var d = (j && j.device) || {};
  var out = { mqtt: {}, device: {} }, e = [];

  out.mqtt.enabled = !!m.enabled;
  out.mqtt.host = str(m.host);
  if (out.mqtt.enabled && !out.mqtt.host) e.push('a broker address is required to enable MQTT');

  if (m.port === null || m.port === undefined || m.port === '') {
    out.mqtt.port = null;
  } else {
    var port = parseInt(m.port, 10);
    if (!(port >= 1 && port <= 65535)) e.push('port must be between 1 and 65535');
    else out.mqtt.port = port;
  }

  out.mqtt.tls = !!m.tls;
  out.mqtt.tlsRejectUnauthorized = m.tlsRejectUnauthorized !== false;
  out.mqtt.username = str(m.username);

  /*
   * The password is never sent to the browser, so an absent field means
   * "unchanged" rather than "clear it". Clearing needs an explicit "".
   */
  if (typeof m.password === 'string') out.mqtt.password = m.password;

  out.mqtt.topicPrefix = str(m.topicPrefix) || 'lgtv';
  if (badTopic(out.mqtt.topicPrefix)) e.push('topic prefix cannot contain +, # or spaces, or start or end with /');
  out.mqtt.discoveryPrefix = str(m.discoveryPrefix) || 'homeassistant';
  if (badTopic(out.mqtt.discoveryPrefix)) e.push('discovery prefix cannot contain +, # or spaces, or start or end with /');

  var iv = parseInt(m.telemetryIntervalMs, 10);
  if (!(iv >= 1000 && iv <= 600000)) e.push('telemetry interval must be between 1000 and 600000 ms');
  else out.mqtt.telemetryIntervalMs = iv;

  /*
   * The device id keys every discovery topic and every entity id in Home
   * Assistant. Changing it orphans the old entities rather than renaming them.
   */
  out.device.id = str(d.id);
  if (!/^[a-z0-9_]{1,64}$/.test(out.device.id)) e.push('device id must be 1-64 characters of a-z, 0-9 or _');
  out.device.name = str(d.name);

  return { errors: e, value: out };
}

function writeSettings(patch, cb) {
  var file = readConfigFile();
  for (var section in patch) {
    file[section] = file[section] || {};
    for (var k in patch[section]) file[section][k] = patch[section][k];
  }
  try {
    var tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.chmodSync(tmp, 0600);
    fs.renameSync(tmp, CONFIG_FILE);   // atomic: never leave a half-written config
  } catch (err) {
    return cb(err);
  }
  cb(null);
}

/*
 * MQTT is wired up once at startup - the client, its keepalive, the telemetry
 * timer and every discovery topic close over the config that was current then.
 * Restarting the process is the one way to apply new broker settings that
 * cannot leave a half-migrated bridge behind.
 */
function restartSelf() {
  var ctl = [path.join(__dirname, 'tvwebctl'), '/var/lib/tvweb/tvwebctl'];
  for (var i = 0; i < ctl.length; i++) {
    if (!fs.existsSync(ctl[i])) continue;
    try {
      child_process.spawn('/bin/sh', [ctl[i], 'restart'], {
        detached: true, stdio: 'ignore'
      }).unref();
      return true;
    } catch (e) {
      console.error('restart failed: ' + e.message);
    }
  }
  return false;
}

function authed(q) {
  return !CONFIG.token || q.k === CONFIG.token;
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    if (UI_HTML) {
      var enc = req.headers['accept-encoding'] || '';
      if (UI_HTML_GZ && enc.indexOf('gzip') !== -1) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': UI_HTML_GZ.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        return res.end(UI_HTML_GZ);
      }
      return send(res, 200, UI_HTML, 'text/html; charset=utf-8');
    }
    // 503, not 200: the dashboard is genuinely unavailable, and a monitor
    // polling this should see that rather than a page that says so in prose.
    return send(res, 503, missingAssetsPage(), 'text/html; charset=utf-8');
  }

  if (pathname.indexOf('/assets/') === 0) {
    var file = assetPath(pathname.slice('/assets/'.length));
    if (!file) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    var mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (ASSET_CACHE[file]) {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': ASSET_CACHE[file].length,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(ASSET_CACHE[file]);
    }
    return fs.readFile(file, function (e, buf) {
      if (e) return send(res, 500, JSON.stringify({ ok: false, error: 'read failed' }));
      ASSET_CACHE[file] = buf;
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    });
  }

  if (pathname.indexOf('/api/') === 0 && !authed(u.query)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (pathname === '/api/caps') {
    return send(res, 200, JSON.stringify({
      ok: true, allowControl: CONFIG.allowControl, allowPower: CONFIG.allowPower
    }));
  }

  if (pathname === '/api/screensaver') {
    return send(res, 200, JSON.stringify(screensaverList()));
  }

  if (pathname === '/api/hdmi') {
    return hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/servicemenu') {
    return serviceMenuState(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/oledcare') {
    return readOledProtections(function (live) {
      collectStats(function (st) {
        var oled = st.oled || {};
        send(res, 200, JSON.stringify({
          ok: true,
          isOled: !!st.oled,
          // Whether this set has the service the service menu goes through.
          serviceControls: oledProtControllable(),
          writable: CONFIG.allowControl,
          /*
           * null where the set says nothing. Without the service, all there is
           * are the marker files, and a set that writes none of them - a B8
           * writes neither - has not said these are off, only that it does not
           * report them.
           */
          gsr: live ? live.gsr : (oled.gsr_protection ? oled.gsr_protection === 'Active' : null),
          tpc: live ? live.tpc : (oled.asbl_protection ? oled.asbl_protection === 'Active' : null),
          gsrStressCount: live ? live.gsrStressCount : null,
          screenShift: oled.screen_shift || null,
          logoDimming: oled.logo_dimming || null,
          // The panel's own wear figures, which belong beside the switches
          // that decide how hard it is worked.
          panelHours: (oled.panel_hours === undefined) ? null : oled.panel_hours,
          hoursUntilComp: (oled.hours_until_comp === undefined) ? null : oled.hours_until_comp,
          hoursUntilRefresher: (oled.hours_until_refresher === undefined) ? null : oled.hours_until_refresher,
          compStatus: oled.comp_status || null,
          refresherStatus: oled.refresher_status || null,
          compCycles: (oled.comp_cycles === undefined) ? null : oled.comp_cycles,
          refresherCycles: (oled.refresher_cycles === undefined) ? null : oled.refresher_cycles,
          failureAlerts: (oled.failure_alerts === undefined) ? null : oled.failure_alerts
        }));
      });
    });
  }

  if (pathname === '/api/cpu') {
    return collectCpuProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    return collectProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/privacy') {
    return collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (pathname === '/api/stats') {
    return collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!authed(u.query)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    var mc = CONFIG.mqtt || {};
    return send(res, 200, JSON.stringify({
      ok: true,
      writable: CONFIG.allowControl,
      configFile: CONFIG_FILE,
      mqtt: {
        enabled: !!mc.enabled,
        host: mc.host || '',
        port: mc.port === undefined ? null : mc.port,
        tls: !!mc.tls,
        tlsRejectUnauthorized: mc.tlsRejectUnauthorized !== false,
        username: mc.username || '',
        // The password is deliberately not returned; only whether one is set.
        passwordSet: !!mc.password,
        topicPrefix: mc.topicPrefix || 'lgtv',
        discoveryPrefix: mc.discoveryPrefix || 'homeassistant',
        telemetryIntervalMs: mc.telemetryIntervalMs || 10000
      },
      device: {
        id: (CONFIG.device && CONFIG.device.id) || '',
        name: (CONFIG.device && CONFIG.device.name) || ''
      },
      /* Ages rather than timestamps: the TV's clock is often minutes off the
         browser's, and a negative "last publish" reads as a fault. */
      status: {
        state: MQTT_STATUS.state,
        broker: MQTT_STATUS.broker,
        tls: MQTT_STATUS.tls,
        detail: MQTT_STATUS.detail,
        forMs: Date.now() - MQTT_STATUS.since,
        lastPublishMs: MQTT_STATUS.lastPublish ? Date.now() - MQTT_STATUS.lastPublish : null
      }
    }));
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!authed(u.query)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    if (!CONFIG.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'controls disabled in config' }));
    }
    var sctype = String(req.headers['content-type'] || '').toLowerCase();
    if (sctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var sorigin = req.headers.origin;
    if (sorigin && String(sorigin).replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
    var sbody = '';
    req.on('data', function (d) {
      sbody += d;
      if (sbody.length > 8192) req.destroy();
    });
    req.on('end', function () {
      var j = null;
      try { j = JSON.parse(sbody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      var v = validateSettings(j);
      if (v.errors.length) {
        return send(res, 400, JSON.stringify({ ok: false, error: v.errors.join('; ') }));
      }
      writeSettings(v.value, function (err) {
        if (err) {
          return send(res, 500, JSON.stringify({ ok: false, error: 'could not write ' + CONFIG_FILE + ': ' + err.message }));
        }
        console.log('settings: saved to ' + CONFIG_FILE + ', restarting to apply');
        /*
         * Answer before restarting: the restart kills this process, and the
         * browser needs the result to know the save itself succeeded.
         */
        send(res, 200, JSON.stringify({ ok: true, restarting: true }));
        setTimeout(function () {
          if (!restartSelf()) console.error('settings: no tvwebctl found - restart manually to apply');
        }, 250);
      });
    });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    /*
     * CSRF guard. No CORS grant is sent, so another site cannot read the
     * reply - but a POST with a "simple" content type (text/plain,
     * form-urlencoded) is still *delivered* without a preflight, and the TV
     * has acted on it by the time the response is discarded. Requiring
     * application/json forces a preflight, which this server never approves,
     * and rejecting cross-site Origins closes the gap for anything that does
     * slip through.
     */
    var ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({
        ok: false, error: 'Content-Type must be application/json'
      }));
    }
    var origin = req.headers.origin;
    if (origin) {
      var hostHdr = String(req.headers.host || '');
      var oHost = String(origin).replace(/^https?:\/\//, '');
      if (oHost !== hostHdr) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
      }
    }
    var body = '';
    req.on('data', function (d) {
      body += d;
      if (body.length > 4096) req.destroy();   // do not buffer junk
    });
    req.on('end', function () {
      var j = {};
      try { j = JSON.parse(body); } catch (e) {}
      doControl(j.action, j.value, function (r) { send(res, 200, JSON.stringify(r)); });
    });
    return;
  }

  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
});

var webEnabled = WEB_ENABLED;
var mqttEnabled = !!(CONFIG.mqtt && CONFIG.mqtt.enabled && CONFIG.mqtt.host);

/*
 * Refuse to sit there looking healthy while doing nothing. With both the
 * dashboard and the MQTT bridge switched off there is no reason for the
 * process to exist, and a silent no-op is harder to diagnose than an exit.
 */
if (!webEnabled && !mqttEnabled) {
  console.error('nothing to do: web.enabled is false and mqtt is not configured.');
  console.error('enable one of them in config.json.');
  process.exit(1);
}

(function checkBootAdBlock() {
  try {
    if (fs.existsSync(ADBLOCK_FLAG_FILE) && !isAdBlockActive() && fs.existsSync(ADBLOCK_HOSTS_FILE)) {
      execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
        // The isAdBlockActive() above cached "not mounted" moments ago, and
        // that answer is good for 30s - long enough to report the sinkhole off
        // on every boot it restores.
        cachedAdBlockActive = null;
        cachedPrivacy = null;
        if (!err) console.log('adblock: restored /etc/hosts bind-mount from previous boot');
      });
    }
  } catch (e) {}
})();

if (webEnabled) {
  server.listen(CONFIG.port, CONFIG.host, function () {
    console.log('tvweb listening on ' + CONFIG.host + ':' + CONFIG.port +
                '  control=' + CONFIG.allowControl + '  power=' + CONFIG.allowPower +
                '  auth=' + (CONFIG.token ? 'token' : 'none'));
    detectOled(function () {});   // resolve and log panel type up front
  detectLogoLight(function () {});
  });
} else {
  console.log('web dashboard disabled (web.enabled=false) - mqtt bridge only');
  detectOled(function () {});
}

// ---------------------------------------------------------------- MiniMQTT Client (ES5)
function encodeVarLength(len) {
  var bytes = [];
  do {
    var digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit = digit | 0x80;
    bytes.push(digit);
  } while (len > 0);
  return (typeof Buffer.from === 'function') ? Buffer.from(bytes) : new Buffer(bytes);
}

function toBuffer(data, enc) {
  return (typeof Buffer.from === 'function') ? Buffer.from(data, enc) : new Buffer(data, enc);
}

function MiniMQTT(opts) {
  this.opts = opts || {};
  this.client = null;
  this.connected = false;
  this.packetId = 1;
  this.buffer = toBuffer([]);
  this.pingTimer = null;
  this.retryTimer = null;
  this.subscriptions = [];
  this.listeners = {};
}

MiniMQTT.prototype.on = function(event, fn) {
  this.listeners[event] = this.listeners[event] || [];
  this.listeners[event].push(fn);
};

MiniMQTT.prototype.emit = function(event, a, b) {
  var list = this.listeners[event] || [];
  for (var i = 0; i < list.length; i++) list[i](a, b);
};

MiniMQTT.prototype.connect = function() {
  var self = this;
  if (this.client) return;
  clearTimeout(this.retryTimer);

  /*
   * Start each connection on an empty buffer. A drop mid-packet - a broker
   * restart, a Wi-Fi blip - leaves a partial packet here, and the new
   * connection's CONNACK would be appended to that fragment. The parser reads
   * the remaining length from the fragment's bytes, waits for a packet that
   * never completes, and the client stays unconnected: publish() then silently
   * returns and the bridge goes quiet until the process restarts.
   */
  this.buffer = toBuffer([]);

  /*
   * Plain TCP by default, since that is what a typical home broker listens on.
   * With mqtt.tls set, connect over TLS instead - otherwise the username and
   * password cross the LAN in cleartext inside every CONNECT packet, and a
   * reconnect loop resends them every few seconds.
   */
  var socket;
  if (this.opts.tls) {
    socket = tls.connect({
      host: this.opts.host,
      port: this.opts.port || 8883,
      servername: this.opts.host,
      // Self-signed broker certs are common on home networks. Turning this
      // off keeps the traffic encrypted but stops authenticating the broker,
      // so only do it on a network you trust.
      rejectUnauthorized: this.opts.tlsRejectUnauthorized !== false
    });
  } else {
    socket = net.createConnection({ host: this.opts.host, port: this.opts.port || 1883 });
  }
  this.client = socket;

  socket.on(self.opts.tls ? 'secureConnect' : 'connect', function() {
    var protoName = toBuffer([0, 4, 77, 81, 84, 84]); // 'MQTT'
    var protoLevel = toBuffer([4]); // 3.1.1
    var flags = 0x02; // CleanSession
    if (self.opts.will) {
      flags |= 0x04; // Will flag
      if (self.opts.will.retain) flags |= 0x20;
    }
    if (self.opts.username) flags |= 0x80;
    if (self.opts.password) flags |= 0x40;

    var flagBuf = toBuffer([flags]);
    var keepAlive = toBuffer([0, 60]); // 60s
    var varHeader = Buffer.concat([protoName, protoLevel, flagBuf, keepAlive]);

    var payloads = [];
    var cid = self.opts.clientId || ('lgtv_' + Math.random().toString(16).slice(2, 8));
    var cidBuf = toBuffer(cid, 'utf8');
    var cidLen = toBuffer([cidBuf.length >> 8, cidBuf.length & 0xff]);
    payloads.push(cidLen, cidBuf);

    if (self.opts.will) {
      var wtBuf = toBuffer(self.opts.will.topic, 'utf8');
      payloads.push(toBuffer([wtBuf.length >> 8, wtBuf.length & 0xff]), wtBuf);
      var wmBuf = toBuffer(self.opts.will.payload || '', 'utf8');
      payloads.push(toBuffer([wmBuf.length >> 8, wmBuf.length & 0xff]), wmBuf);
    }

    if (self.opts.username) {
      var uBuf = toBuffer(self.opts.username, 'utf8');
      payloads.push(toBuffer([uBuf.length >> 8, uBuf.length & 0xff]), uBuf);
    }
    if (self.opts.password) {
      var pBuf = toBuffer(self.opts.password, 'utf8');
      payloads.push(toBuffer([pBuf.length >> 8, pBuf.length & 0xff]), pBuf);
    }

    var payload = Buffer.concat(payloads);
    var remLen = encodeVarLength(varHeader.length + payload.length);
    var packet = Buffer.concat([toBuffer([0x10]), remLen, varHeader, payload]);
    socket.write(packet);
  });

  socket.on('data', function(chunk) {
    self.buffer = Buffer.concat([self.buffer, chunk]);
    self._parse();
  });

  socket.on('close', function() {
    var wasConnected = self.connected;
    self.connected = false;
    self.client = null;
    clearInterval(self.pingTimer);
    if (wasConnected) {
      console.log('mqtt: disconnected from ' + self.opts.host + ':' + (self.opts.port || (self.opts.tls ? 8883 : 1883)));
      self.emit('close');
    }
    self.retryTimer = setTimeout(function() { self.connect(); }, 5000);
  });

  socket.on('error', function(err) {
    self.emit('error', err);
    if (self.client) {
      self.client.destroy();
    }
  });
};

MiniMQTT.prototype._parse = function() {
  while (this.buffer.length >= 2) {
    var packetType = this.buffer[0] >> 4;
    var flags = this.buffer[0] & 0x0f;
    var multiplier = 1, remLen = 0, idx = 1, digit;
    do {
      if (idx >= this.buffer.length) return; // wait for more data
      digit = this.buffer[idx++];
      remLen += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    var totalLen = idx + remLen;
    if (this.buffer.length < totalLen) return; // wait for full packet

    var packetBody = this.buffer.slice(idx, totalLen);
    this.buffer = this.buffer.slice(totalLen);

    if (packetType === 2) { // CONNACK
      var returnCode = packetBody[1];
      if (returnCode === 0) {
        this.connected = true;
        var self = this;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(function() {
          if (self.client && self.connected) {
            self.client.write(toBuffer([0xc0, 0x00])); // PINGREQ
          }
        }, 30000);
        // Resubscribe to all saved subscriptions
        for (var i = 0; i < this.subscriptions.length; i++) {
          this._sendSubscribe(this.subscriptions[i]);
        }
        this.emit('connect');
      } else {
        this.emit('error', new Error('CONNACK rejected with code ' + returnCode));
      }
    } else if (packetType === 3) { // PUBLISH
      var qos = (flags >> 1) & 0x03;
      var tLen = (packetBody[0] << 8) | packetBody[1];
      var topic = packetBody.slice(2, 2 + tLen).toString('utf8');
      var pOffset = 2 + tLen;
      if (qos > 0) pOffset += 2; // skip packet identifier
      var payload = packetBody.slice(pOffset).toString('utf8');
      this.emit('message', topic, payload);
    }
  }
};

MiniMQTT.prototype._sendSubscribe = function(topic) {
  if (!this.client || !this.connected) return;
  var pid = this.packetId++;
  if (this.packetId > 65535) this.packetId = 1;
  var pidBuf = toBuffer([pid >> 8, pid & 0xff]);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var qosBuf = toBuffer([0]);
  var payload = Buffer.concat([pidBuf, tLen, tBuf, qosBuf]);
  var remLen = encodeVarLength(payload.length);
  var packet = Buffer.concat([toBuffer([0x82]), remLen, payload]);
  this.client.write(packet);
};

MiniMQTT.prototype.subscribe = function(topic) {
  if (this.subscriptions.indexOf(topic) === -1) {
    this.subscriptions.push(topic);
  }
  this._sendSubscribe(topic);
};

MiniMQTT.prototype.publish = function(topic, message, retain) {
  if (!this.client || !this.connected) return;
  var firstByte = 0x30 | (retain ? 0x01 : 0x00);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var mBuf = toBuffer(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
  var remLen = encodeVarLength(tLen.length + tBuf.length + mBuf.length);
  var packet = Buffer.concat([toBuffer([firstByte]), remLen, tLen, tBuf, mBuf]);
  this.client.write(packet);
};

MiniMQTT.prototype.disconnect = function() {
  if (this.client && this.connected) {
    try {
      this.client.write(toBuffer([0xe0, 0x00])); // DISCONNECT
    } catch (e) {}
    this.connected = false;
    try {
      this.client.end();
    } catch (e) {}
  }
};

// ---------------------------------------------------------------- Home Assistant Integration
/*
 * Home Assistant logs an error for every select state outside that entity's
 * own option list, and the TV reports plenty a list cannot hold: a launched
 * app where an input is expected, an HDR picture mode, an input where an app
 * is expected. Anything not offered is published as "None", which the MQTT
 * select reads as unknown (it resets on a case-insensitive "none") instead
 * of logging.
 */
function selectState(expr, options) {
  var quoted = [];
  for (var i = 0; i < options.length; i++) quoted.push('\'' + options[i] + '\'');
  return '{{ (' + expr + ') if (' + expr + ') in [' + quoted.join(', ') + '] else \'None\' }}';
}

/*
 * What the dashboard reports about the bridge. The MQTT client is wired up
 * once at startup against the config as it was then, so this is the only way
 * to tell whether the broker settings on screen are the ones actually running.
 */
var MQTT_STATUS = {
  state: 'disabled',   // disabled | connecting | connected | error
  broker: '',
  tls: false,
  detail: '',
  since: Date.now(),
  lastPublish: 0
};

function mqttStatus(state, detail) {
  if (MQTT_STATUS.state !== state) MQTT_STATUS.since = Date.now();
  MQTT_STATUS.state = state;
  MQTT_STATUS.detail = detail || '';
}

function setupHomeAssistant() {
  if (!CONFIG.mqtt || !CONFIG.mqtt.enabled || !CONFIG.mqtt.host) {
    console.log('mqtt: disabled (no host configured)');
    mqttStatus('disabled', CONFIG.mqtt && CONFIG.mqtt.enabled ? 'no broker address set' : '');
    return;
  }

  var pfx = CONFIG.mqtt.topicPrefix || 'lgtv';
  var discPfx = CONFIG.mqtt.discoveryPrefix || 'homeassistant';
  var devId = (CONFIG.device && CONFIG.device.id) || 'lg_b8_tv';
  console.log('mqtt: device id "' + devId + '", topic prefix "' + pfx + '"');
  var statusTopic = pfx + '/status';
  var telemetryTopic = pfx + '/telemetry';
  var stateScreenTopic = pfx + '/state/screen';
  var cmdScreenTopic = pfx + '/command/screen';
  var cmdMuteTopic = pfx + '/command/mute';
  var cmdVolTopic = pfx + '/command/volume';
  var cmdInputTopic = pfx + '/command/input';
  var cmdToastTopic = pfx + '/command/toast';

  var devInfo = {
    identifiers: [devId],
    name: (CONFIG.device && CONFIG.device.name) || 'LG webOS TV',
    model: (CONFIG.device && CONFIG.device.model) || 'webOS TV',
    manufacturer: (CONFIG.device && CONFIG.device.manufacturer) || 'LG',
    sw_version: (CONFIG.device && CONFIG.device.sw_version) || 'webOS (tvweb)'
  };

  var useTls = !!CONFIG.mqtt.tls;
  var mqttClient = new MiniMQTT({
    host: CONFIG.mqtt.host,
    port: CONFIG.mqtt.port || (useTls ? 8883 : 1883),
    tls: useTls,
    tlsRejectUnauthorized: CONFIG.mqtt.tlsRejectUnauthorized !== false,
    username: CONFIG.mqtt.username || null,
    password: CONFIG.mqtt.password || null,
    clientId: (CONFIG.mqtt.clientId || (devId + '_tvweb')),
    will: {
      topic: statusTopic,
      payload: 'offline',
      retain: true
    }
  });

  MQTT_STATUS.broker = CONFIG.mqtt.host + ':' + mqttClient.opts.port;
  MQTT_STATUS.tls = useTls;
  mqttStatus('connecting', '');

  /*
   * Entities published under a different component than they are now. Home
   * Assistant keys a discovered entity on its config topic, so a sensor that
   * became a switch is not replaced by the switch - it is left behind, still
   * holding the last value it was sent.
   */
  var RETIRED_ENTITIES = [
    { type: 'sensor', id: 'oled_screen_shift' },
    { type: 'sensor', id: 'oled_logo_dimming' }
  ];

  function publishDiscovery() {
    for (var r = 0; r < RETIRED_ENTITIES.length; r++) {
      mqttClient.publish(discPfx + '/' + RETIRED_ENTITIES[r].type + '/' + devId + '/' +
                         RETIRED_ENTITIES[r].id + '/config', '', true);
    }
    var entities = [
      {
        type: 'sensor', id: 'soc_temperature',
        payload: {
          name: 'SoC Temperature',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.temp }}',
          unit_of_measurement: '°C',
          device_class: 'temperature',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'cpu_load',
        payload: {
          name: 'CPU Usage',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.load }}',
          unit_of_measurement: '%',
          state_class: 'measurement',
          icon: 'mdi:cpu-64-bit'
        }
      },
      {
        type: 'sensor', id: 'memory_usage',
        payload: {
          name: 'Memory Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.mem.total - value_json.mem.avail) / value_json.mem.total * 100) | round(1) if value_json.mem.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:memory'
        }
      },
      {
        type: 'sensor', id: 'swap_usage',
        payload: {
          name: 'Swap Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.swap.total - value_json.swap.free) / value_json.swap.total * 100) | round(1) if value_json.swap.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:server'
        }
      },
      {
        type: 'sensor', id: 'wifi_signal',
        payload: {
          name: 'Wi-Fi Signal',
          state_topic: telemetryTopic,
          // none, not 0: a wired set has no signal to report, and 0 dBm would
          // enter the history as though it had been measured.
          value_template: '{{ value_json.wifi.level if value_json.wifi else none }}',
          unit_of_measurement: 'dBm',
          device_class: 'signal_strength',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'download_rate',
        payload: {
          name: 'Download Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.rx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:download-network'
        }
      },
      {
        type: 'sensor', id: 'upload_rate',
        payload: {
          name: 'Upload Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.tx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:upload-network'
        }
      },
      {
        type: 'sensor', id: 'flash_health',
        payload: {
          name: 'Flash Storage Health',
          state_topic: telemetryTopic,
          /* pre_eol_info, not the inverted wear band: emmc.health is derived
             from the same register as emmc.wear, so the two sensors were
             reporting one number twice. The name still fits - Normal, Warning
             and Urgent are exactly a health status. */
          value_template: '{{ value_json.emmc.eol }}',
          icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'flash_wear',
        payload: {
          name: 'Flash Wear Level',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.emmc.wear }}',
          icon: 'mdi:wrench-clock'
        }
      },
      {
        type: 'sensor', id: 'active_app',
        payload: {
          name: 'Active App',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.display_title or value_json.app_name or value_json.app }}',
          icon: 'mdi:television-play'
        }
      },
      {
        type: 'sensor', id: 'play_state',
        payload: {
          name: 'Player State',
          state_topic: telemetryTopic,
          // Absent on a set whose media service does not answer, rather than
          // reported as stopped - nothing playing and nothing to ask are
          // different things. On an external input this tracks the HDMI
          // pipeline rather than the source's own transport state.
          value_template: '{{ value_json.media.state if value_json.media else None }}',
          icon: 'mdi:play-pause'
        }
      },
      {
        type: 'sensor', id: 'dynamic_range',
        payload: {
          name: 'Dynamic Range',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.dynamicRange if value_json.picture else "SDR" }}',
          icon: 'mdi:video-vintage'
        }
      },
      {
        type: 'sensor', id: 'picture_mode',
        payload: {
          name: 'Picture Mode',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.mode if value_json.picture else "Unknown" }}',
          icon: 'mdi:palette'
        }
      },
      {
        type: 'sensor', id: 'oled_light',
        payload: {
          name: 'OLED Light',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.backlight if value_json.picture else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:brightness-6'
        }
      },
      {
        type: 'sensor', id: 'video_signal',
        payload: {
          name: 'Video Signal',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.signal or "Internal / Standby" }}',
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'sensor', id: 'hdmi_link_mode',
        payload: {
          name: 'HDMI Link Protocol',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.phy_mode if value_json.hdmi_diag and value_json.hdmi_diag.phy_mode else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'sensor', id: 'hdmi_chroma',
        payload: {
          name: 'HDMI Chroma Format',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.chroma if value_json.hdmi_diag and value_json.hdmi_diag.chroma else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:palette'
        }
      },
      {
        type: 'sensor', id: 'hdmi_hdcp',
        payload: {
          name: 'HDMI HDCP Version',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.hdcp if value_json.hdmi_diag and value_json.hdmi_diag.hdcp else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:lock-check'
        }
      },
      {
        type: 'sensor', id: 'hdmi_cable_errors',
        payload: {
          name: 'HDMI Cable Bit Errors',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.phy_errors if value_json.hdmi_diag and value_json.hdmi_diag.phy_errors is not none else none }}',
          state_class: 'measurement',
          entity_category: 'diagnostic',
          icon: 'mdi:alert-outline'
        }
      },
      {
        type: 'binary_sensor', id: 'hdmi_allm',
        payload: {
          name: 'Auto Low Latency Mode (ALLM)',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.hdmi_diag.allm else "OFF") if value_json.hdmi_diag and value_json.hdmi_diag.allm is not none else none }}',
          icon: 'mdi:gamepad-variant'
        }
      },
      {
        type: 'binary_sensor', id: 'hdmi_vrr',
        payload: {
          name: 'Variable Refresh Rate (VRR)',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.hdmi_diag.vrr else "OFF") if value_json.hdmi_diag and value_json.hdmi_diag.vrr is not none else none }}',
          icon: 'mdi:speedometer'
        }
      },
      {
        type: 'sensor', id: 'video_colorimetry',
        payload: {
          name: 'Video Color Space',
          state_topic: telemetryTopic,
          // none, not "BT.709": defaulting to a colour space states a fact
          // about the signal that was never read, and states it wrongly on
          // anything wide-gamut. A set that does not report one reports none.
          value_template: '{{ value_json.picture_engine.colorimetry if value_json.picture_engine and value_json.picture_engine.colorimetry else none }}',
          icon: 'mdi:palette-swatch'
        }
      },
      {
        type: 'sensor', id: 'audio_output',
        payload: {
          name: 'Audio Output',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.audio_output or "Internal" }}',
          icon: 'mdi:speaker'
        }
      },
      {
        type: 'sensor', id: 'soc_current',
        payload: {
          name: 'SoC Current',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.power.current_ma if value_json.power else 0 }}',
          unit_of_measurement: 'mA',
          device_class: 'current',
          state_class: 'measurement',
          icon: 'mdi:current-ac'
        }
      },
      {
        type: 'sensor', id: 'uptime',
        payload: {
          name: 'Uptime',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.uptime }}',
          unit_of_measurement: 's',
          device_class: 'duration',
          suggested_display_precision: 0,
          icon: 'mdi:clock-outline'
        }
      },
      {
        /*
         * This server's own version, not the TV's - the device's sw_version
         * already carries the firmware. The id stays tvweb_version: it is the
         * unique_id an existing install is already discovered under, and
         * changing it would orphan that entity and register a second one.
         * Diagnostic: it belongs beside the firmware, not among the readings.
         */
        type: 'sensor', id: 'tvweb_version',
        payload: {
          name: 'Server Version',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.tvwebVersion }}',
          entity_category: 'diagnostic',
          icon: 'mdi:tag-outline'
        }
      },
      {
        /*
         * For the wake_on_lan.send_magic_packet action the Home Assistant
         * guide sets up, where the address is currently left to the reader.
         * Diagnostic: it belongs on the device page beside the firmware, and
         * it is read once rather than watched.
         */
        type: 'sensor', id: 'mac_address',
        payload: {
          name: 'MAC Address',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.mac if value_json.mac else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:ethernet'
        }
      },
      {
        type: 'sensor', id: 'remote_battery',
        payload: {
          name: 'Remote Battery',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.remote.battery if value_json.remote and value_json.remote.battery is not none else none }}',
          unit_of_measurement: '%',
          device_class: 'battery',
          state_class: 'measurement',
          entity_category: 'diagnostic',
          icon: 'mdi:remote'
        }
      },
      {
        type: 'sensor', id: 'soc_architecture',
        payload: {
          name: 'SoC Architecture',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hardware.soc_arch if value_json.hardware and value_json.hardware.soc_arch else "Unknown" }}',
          entity_category: 'diagnostic',
          icon: 'mdi:cpu-64-bit'
        }
      },
      {
        type: 'sensor', id: 'oled_cell_type',
        payload: {
          name: 'OLED Cell Info',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.panel_silicon.cell if value_json.panel_silicon and value_json.panel_silicon.cell else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:monitor-cell'
        }
      },
      {
        type: 'sensor', id: 'tcon_firmware',
        payload: {
          name: 'TCON Firmware',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.panel_silicon.tcon_firmware if value_json.panel_silicon and value_json.panel_silicon.tcon_firmware else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:chip'
        }
      },
      {
        type: 'switch', id: 'display_panel',
        payload: {
          name: 'OLED Display Panel',
          command_topic: cmdScreenTopic,
          state_topic: stateScreenTopic,
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'switch', id: 'mute',
        payload: {
          name: 'Mute',
          command_topic: cmdMuteTopic,
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.muted else \'OFF\' }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:volume-mute'
        }
      },
      {
        type: 'number', id: 'volume',
        payload: {
          name: 'Volume',
          command_topic: cmdVolTopic,
          state_topic: telemetryTopic,
          value_template: '{{ value_json.volume }}',
          min: 0,
          max: 100,
          step: 1,
          icon: 'mdi:volume-high'
        }
      },
      {
        type: 'select', id: 'input_source',
        payload: {
          name: 'Input Source',
          command_topic: cmdInputTopic,
          state_topic: telemetryTopic,
          value_template: selectState('value_json.app', Object.keys(INPUTS)),
          options: Object.keys(INPUTS),
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'text', id: 'screen_notification',
        payload: {
          name: 'Screen Notification',
          command_topic: cmdToastTopic,
          icon: 'mdi:message-text-outline',
          mode: 'text'
        }
      },
      {
        type: 'sensor', id: 'oled_panel_hours',
        payload: {
          name: 'OLED Panel Hours',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.panel_hours if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'total_increasing',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_compensation',
        payload: {
          name: 'OLED Hours Since Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:progress-clock'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_compensation',
        payload: {
          name: 'OLED Hours Until Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:timer-sand'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_refresher',
        payload: {
          name: 'OLED Hours Since Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:history'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_refresher',
        payload: {
          name: 'OLED Hours Until Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:update'
        }
      },
      {
        type: 'sensor', id: 'oled_compensation_status',
        payload: {
          name: 'OLED Compensation Status',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.comp_status if value_json.oled else "Unknown" }}',
          icon: 'mdi:autorenew'
        }
      },
      {
        type: 'sensor', id: 'oled_refresher_status',
        payload: {
          name: 'Pixel Refresher Status',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.refresher_status if value_json.oled else "Unknown" }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        /*
         * Both of these are settings rather than readings, so they carry their
         * own state and need no separate sensor. The panel protections beside
         * them - ASBL, GSR - are hardware behaviour and stay read-only.
         */
        type: 'switch', id: 'oled_screen_shift',
        payload: {
          name: 'OLED Screen Shift',
          command_topic: pfx + '/command/screenShift',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.oled.screen_shift == "on" else "OFF") if value_json.oled and value_json.oled.screen_shift else none }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:arrow-all'
        }
      },
      {
        type: 'select', id: 'oled_logo_dimming',
        payload: {
          name: 'OLED Logo Dimming',
          command_topic: pfx + '/command/logoDimming',
          state_topic: telemetryTopic,
          // LG calls the strongest setting "strong"; the TV's own menu shows it
          // as High, and so does the dashboard.
          options: ['Off', 'Light', 'High'],
          command_template: '{{ {"Off":"off","Light":"light","High":"strong"}[value] }}',
          value_template: '{{ {"off":"Off","light":"Light","strong":"High"}.get(value_json.oled.logo_dimming, "Off") if value_json.oled and value_json.oled.logo_dimming else none }}',
          icon: 'mdi:television-guide'
        }
      },
      {
        type: 'sensor', id: 'oled_short_cycles',
        payload: {
          name: 'OLED Short Cycles Completed',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.comp_cycles if value_json.oled and value_json.oled.comp_cycles is not none else none }}',
          state_class: 'total_increasing',
          entity_category: 'diagnostic',
          icon: 'mdi:counter'
        }
      },
      {
        type: 'sensor', id: 'oled_refresher_cycles',
        payload: {
          name: 'OLED Refresher Cycles Completed',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.refresher_cycles if value_json.oled and value_json.oled.refresher_cycles is not none else none }}',
          state_class: 'total_increasing',
          entity_category: 'diagnostic',
          icon: 'mdi:counter'
        }
      },
      {
        type: 'sensor', id: 'oled_failure_alerts',
        payload: {
          name: 'OLED Compensation Failures',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.failure_alerts if value_json.oled and value_json.oled.failure_alerts is not none else 0 }}',
          entity_category: 'diagnostic',
          icon: 'mdi:alert-circle-outline'
        }
      },
      {
        type: 'binary_sensor', id: 'oled_asbl_dimmer',
        payload: {
          name: 'OLED ASBL Protection',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.oled and value_json.oled.asbl_protection == "Active" else "OFF" }}',
          entity_category: 'diagnostic',
          icon: 'mdi:shield-check'
        }
      },
      {
        type: 'switch', id: 'pixel_refresher_schedule',
        payload: {
          name: 'Schedule Pixel Refresher',
          command_topic: pfx + '/command/refresher',
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.oled and value_json.oled.refresher_status == \'Scheduled\' else \'OFF\' }}',
          payload_on: 'schedule',
          payload_off: 'cancel',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'select', id: 'picture_mode',
        payload: {
          name: 'Picture Mode',
          command_topic: pfx + '/command/picture_mode',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.mode_raw if value_json.picture else "standard" }}',
          /* The settable modes depend on the dynamic range of what is playing,
             so this is whatever the TV last said it would accept. Discovery is
             republished when that set changes - see publishTelemetry. */
          options: lastPicModes.length
            ? lastPicModes.map(function (m) { return m.value; })
            : ['expert1', 'expert2', 'cinema', 'game', 'standard', 'eco', 'sports'],
          icon: 'mdi:image-filter-black-white'
        }
      },
      {
        type: 'select', id: 'sound_output',
        payload: {
          name: 'Sound Output',
          command_topic: pfx + '/command/sound_output',
          state_topic: telemetryTopic,
          value_template: selectState('value_json.sound.output_raw if value_json.sound else "tv_speaker"',
                                      Object.keys(SOUND_OUTPUT_MAP)),
          options: Object.keys(SOUND_OUTPUT_MAP),
          icon: 'mdi:speaker'
        }
      },
      {
        type: 'select', id: 'app',
        payload: (function () {
          /*
           * Full app ids on both sides: listApps and telemetry's app_id report
           * com.webos.app.livetv, and launch wants that same id back, so the
           * option list needs no translation in either direction.
           */
          var opts = ['com.webos.app.livetv', 'youtube.leanback.v4', 'netflix', 'amazon', 'spotify-beehive', 'com.apple.appletv'];
          var merged = {};
          for (var o = 0; o < opts.length; o++) merged[opts[o]] = 1;
          for (var a = 0; a < installedApps.length; a++) merged[installedApps[a].id] = 1;
          var appOptions = Object.keys(merged);
          return {
            name: 'Launch App',
            command_topic: pfx + '/command/launch_app',
            state_topic: telemetryTopic,
            value_template: selectState('value_json.app_id', appOptions),
            options: appOptions,
            icon: 'mdi:apps'
          };
        })()
      },
      {
        /*
         * Sleep timer. 15 is not an accepted value even though it looks like
         * one - the settings service rejects it. Valid: off, 10, 30, 60, 90, 120.
         */
        type: 'sensor', id: 'gpu_clock',
        payload: {
          name: 'GPU Clock', state_topic: telemetryTopic,
          value_template: '{{ value_json.gpuMhz if value_json.gpuMhz else none }}',
          unit_of_measurement: 'MHz', state_class: 'measurement', icon: 'mdi:expansion-card'
        }
      },
      {
        type: 'sensor', id: 'panel_dimming',
        payload: {
          name: 'Panel Dimming', state_topic: telemetryTopic,
          value_template: '{{ value_json.dimming }}', icon: 'mdi:brightness-auto'
        }
      },
      {
        type: 'sensor', id: 'app_storage_free',
        payload: {
          name: 'App Storage Free', state_topic: telemetryTopic,
          value_template: '{{ (value_json.appStorage.freeMb / 1024) | round(1) if value_json.appStorage else none }}',
          unit_of_measurement: 'GB', state_class: 'measurement', icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'ambient_light',
        payload: {
          name: 'Ambient Light', state_topic: telemetryTopic,
          value_template: '{{ value_json.lightSensor.lux if value_json.lightSensor else none }}',
          device_class: 'illuminance', state_class: 'measurement', icon: 'mdi:brightness-5'
        }
      },
      {
        type: 'select', id: 'sleep_timer',
        payload: {
          name: 'Sleep Timer',
          command_topic: pfx + '/command/sleepTimer',
          state_topic: telemetryTopic,
          options: ['Off', '10 min', '30 min', '60 min', '90 min', '120 min'],
          command_template: '{{ {"Off":"off","10 min":"10","30 min":"30","60 min":"60","90 min":"90","120 min":"120"}[value] }}',
          value_template: '{{ {"off":"Off","10":"10 min","30":"30 min","60":"60 min","90":"90 min","120":"120 min"}.get(value_json.sleepTimer, "Off") }}',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'switch', id: 'standby_light',
        payload: {
          name: 'Standby LED',
          command_topic: pfx + '/command/standbyLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.standby else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:led-on'
        }
      },
      {
        type: 'switch', id: 'logo_light',
        payload: {
          name: 'Logo Light',
          command_topic: pfx + '/command/logoLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.logo else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'button', id: 'screensaver',
        payload: {
          name: 'Start Screensaver',
          command_topic: pfx + '/command/screensaver',
          payload_press: 'press',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        /*
         * The other half of that button. turnOnScreenSaver reports success
         * whether or not anything answered the request, so this is the only
         * confirmation that one is actually on screen.
         */
        type: 'binary_sensor', id: 'screen_saver_active',
        payload: {
          name: 'Screen Saver',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.screenSaver else "OFF" }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'select', id: 'screensaver_mode',
        payload: {
          name: 'Screen Saver',
          command_topic: pfx + '/command/screensaverMode',
          state_topic: telemetryTopic,
          options: ['LG default', 'Clock', 'Starfield', 'Fireworks', 'Panel vitals'],
          command_template: '{{ {"LG default":"stock","Clock":"clock","Starfield":"starfield","Fireworks":"fireworks","Panel vitals":"vitals"}[value] }}',
          value_template: '{{ {"stock":"LG default","clock":"Clock","starfield":"Starfield","fireworks":"Fireworks","vitals":"Panel vitals"}.get(value_json.screensaverMode, "LG default") }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'switch', id: 'ad_blocker',
        payload: {
          name: 'Ad & Telemetry Blocker',
          command_topic: pfx + '/command/adblock',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.privacy and value_json.privacy.adblock and value_json.privacy.adblock.enabled else "OFF" }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:shield-check'
        }
      },
      {
        type: 'button', id: 'play',
        payload: {
          name: 'Play',
          command_topic: pfx + '/command/playback',
          payload_press: 'play',
          icon: 'mdi:play'
        }
      },
      {
        type: 'button', id: 'pause',
        payload: {
          name: 'Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'pause',
          icon: 'mdi:pause'
        }
      },
      {
        type: 'button', id: 'play_pause',
        payload: {
          name: 'Play / Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'playPause',
          icon: 'mdi:play-pause'
        }
      },
      {
        type: 'button', id: 'stop',
        payload: {
          name: 'Stop',
          command_topic: pfx + '/command/playback',
          payload_press: 'stop',
          icon: 'mdi:stop'
        }
      }
    ];

    if (CONFIG.allowPower) {
      entities.push({
        type: 'button', id: 'restart',
        payload: {
          name: 'Restart TV',
          command_topic: pfx + '/command/reboot',
          device_class: 'restart',
          icon: 'mdi:restart'
        }
      });
      entities.push({
        type: 'button', id: 'power_off',
        payload: {
          name: 'Power Off TV',
          command_topic: pfx + '/command/powerOff',
          icon: 'mdi:power'
        }
      });
    }

    /*
     * Panel-lifecycle entities only exist on OLED. On an LCD/QNED set the
     * counters simply are not there, and publishing them would give Home
     * Assistant a permanently "unknown" sensor - or worse, a confident 0 that
     * looks like a real reading. Retained discovery configs are cleared so
     * they disappear from HA rather than lingering as orphans.
     */
    // Each of these has one field behind it, and is published only once this
    // set has reported that field - see hdmiSeen.
    var HDMI_DIAG_ONLY = {
      hdmi_link_mode: 'phy_mode', hdmi_chroma: 'chroma', hdmi_hdcp: 'hdcp',
      hdmi_cable_errors: 'phy_errors', hdmi_allm: 'allm', hdmi_vrr: 'vrr'
    };

    var OLED_ONLY = {
      oled_panel_hours: 1, oled_hours_since_compensation: 1,
      oled_hours_until_compensation: 1, oled_compensation_status: 1,
      oled_hours_since_refresher: 1,
      oled_hours_until_refresher: 1, oled_refresher_status: 1,
      oled_short_cycles: 1, oled_refresher_cycles: 1,
      oled_failure_alerts: 1, oled_asbl_dimmer: 1,
      oled_cell_type: 1, tcon_firmware: 1,
      oled_screen_shift: 1, oled_logo_dimming: 1,
      pixel_refresher_schedule: 1
    };

    /*
     * Withhold remote battery entity if Magic Remote info is absent (e.g. set only uses IR).
     */
    if (!readRemoteInfo()) {
      var keptRemote = [];
      for (var ri = 0; ri < entities.length; ri++) {
        if (entities[ri].id === 'remote_battery') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/remote_battery/config', '', true);
        } else { keptRemote.push(entities[ri]); }
      }
      entities = keptRemote;
    }

    /*
     * Withhold OLED cycle counters & failure alerts on older sets where pnwash files don't exist.
     */
    if (!fs.existsSync('/mnt/lg/cmn_data/pnwash/completedOffRsCount')) {
      var keptCycles = [];
      for (var ci = 0; ci < entities.length; ci++) {
        if (entities[ci].id === 'oled_short_cycles' || entities[ci].id === 'oled_refresher_cycles' || entities[ci].id === 'oled_failure_alerts') {
          mqttClient.publish(discPfx + '/' + entities[ci].type + '/' + devId + '/' + entities[ci].id + '/config', '', true);
        } else { keptCycles.push(entities[ci]); }
      }
      entities = keptCycles;
    }

    /*
     * Withhold panel silicon cell & TCON firmware if not available from panelcontroller.
     */
    if (!HARDWARE_INFO.cell) {
      var keptSilicon = [];
      for (var si = 0; si < entities.length; si++) {
        if (entities[si].id === 'oled_cell_type' || entities[si].id === 'tcon_firmware') {
          mqttClient.publish(discPfx + '/' + entities[si].type + '/' + devId + '/' + entities[si].id + '/config', '', true);
        } else { keptSilicon.push(entities[si]); }
      }
      entities = keptSilicon;
    }

    /*
     * Withhold HDMI 2.1 diagnostics on platforms without /proc/lg/hdmi20.
     */
    if (!fs.existsSync('/proc/lg/hdmi20')) {
      var keptHdmi = [];
      for (var hi = 0; hi < entities.length; hi++) {
        if (entities[hi].id.indexOf('hdmi_') === 0) {
          mqttClient.publish(discPfx + '/' + entities[hi].type + '/' + devId + '/' + entities[hi].id + '/config', '', true);
        } else { keptHdmi.push(entities[hi]); }
      }
      entities = keptHdmi;
    }

    /*
     * Play state, on a set whose media service never answers - webOS 9 has no
     * com.webos.service.acb at all.
     */
    if (!hasMediaState) {
      var keptMedia = [];
      for (var mi = 0; mi < entities.length; mi++) {
        if (entities[mi].id === 'play_state') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/play_state/config', '', true);
        } else { keptMedia.push(entities[mi]); }
      }
      entities = keptMedia;
    }

    /*
     * Withhold colorimetry if /proc/lg/pe/hdr_status does not exist.
     */
    if (!fs.existsSync('/proc/lg/pe/hdr_status')) {
      var keptColor = [];
      for (var cli = 0; cli < entities.length; cli++) {
        if (entities[cli].id === 'video_colorimetry') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/video_colorimetry/config', '', true);
        } else { keptColor.push(entities[cli]); }
      }
      entities = keptColor;
    }

    /*
     * Withhold SoC architecture if unknown.
     */
    if (!HARDWARE_INFO.socArch) {
      var keptArch = [];
      for (var ai = 0; ai < entities.length; ai++) {
        if (entities[ai].id === 'soc_architecture') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/soc_architecture/config', '', true);
        } else { keptArch.push(entities[ai]); }
      }
      entities = keptArch;
    }

    /*
     * Withhold the ambient light entity on sets without the sensor. They still
     * answer getLightSensorData, reporting 65535, so the entity would sit at
     * "unknown" forever instead of simply not existing.
     */
    if (hasLogoLight === false) {
      var keptLogo = [];
      for (var g = 0; g < entities.length; g++) {
        if (entities[g].id === 'logo_light') {
          mqttClient.publish(discPfx + '/switch/' + devId + '/logo_light/config', '', true);
        } else { keptLogo.push(entities[g]); }
      }
      entities = keptLogo;
    }

    /*
     * Same reasoning on platforms with no thermal sensor at all (webOS 3.x):
     * publishing the entity would leave a temperature in Home Assistant that
     * is permanently unknown, which reads as a broken sensor rather than an
     * absent one.
     */
    if (!THERMAL_PRESENT) {
      var keptTemp = [];
      for (var t = 0; t < entities.length; t++) {
        if (entities[t].id === 'soc_temperature') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/soc_temperature/config', '', true);
        } else { keptTemp.push(entities[t]); }
      }
      entities = keptTemp;
    }

    /*
     * Same again for the eMMC wear counters, absent on webOS 3.x. An entity
     * reading "unknown" for the life of the install is indistinguishable from
     * a sensor that has broken.
     */
    if (!EMMC_WEAR_PRESENT) {
      var keptFlash = [];
      for (var f = 0; f < entities.length; f++) {
        if (entities[f].id === 'flash_health' || entities[f].id === 'flash_wear') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/' + entities[f].id + '/config', '', true);
        } else { keptFlash.push(entities[f]); }
      }
      entities = keptFlash;
    }

    if (!hasLightSensor) {
      var keptAmb = [];
      for (var a = 0; a < entities.length; a++) {
        if (entities[a].id === 'ambient_light') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/ambient_light/config', '', true);
        } else { keptAmb.push(entities[a]); }
      }
      entities = keptAmb;
    }

    /*
     * HDMI diagnostics this set has never reported. A B8 has no FRL link, no
     * chroma report, no PHY error counter and no VRR hardware, and an entity
     * that can only ever read unknown - or worse, a confident 0 - is worse
     * than none.
     */
    var keptHdmi = [];
    for (var hi = 0; hi < entities.length; hi++) {
      var hNeeds = HDMI_DIAG_ONLY[entities[hi].id];
      if (hNeeds && !hdmiSeen[hNeeds]) {
        mqttClient.publish(discPfx + '/' + entities[hi].type + '/' + devId + '/' +
                           entities[hi].id + '/config', '', true);
      } else { keptHdmi.push(entities[hi]); }
    }
    entities = keptHdmi;

    /*
     * GPU clock. Withheld on sets whose kernel does not expose the PLL output
     * in /proc/lg/sys/status (such as webOS 9+ / C2).
     */
    if (gpuClockMhz() === null) {
      var keptGpu = [];
      for (var gi = 0; gi < entities.length; gi++) {
        if (entities[gi].id === 'gpu_clock') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/gpu_clock/config', '', true);
        } else { keptGpu.push(entities[gi]); }
      }
      entities = keptGpu;
    }

    /*
     * Panel dimming. OLED sets control light per subpixel rather than via
     * backlight zones — withhold on OLEDs. On LCD/QNED sets the entity stays
     * registered; the template returns null until the first telemetry tick.
     */
    if (isOled === true) {
      var keptDim = [];
      for (var di = 0; di < entities.length; di++) {
        if (entities[di].id === 'panel_dimming') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/panel_dimming/config', '', true);
        } else { keptDim.push(entities[di]); }
      }
      entities = keptDim;
    }

    if (isOled === false) {
      var kept = [];
      for (var d = 0; d < entities.length; d++) {
        if (OLED_ONLY[entities[d].id]) {
          var dead = discPfx + '/' + entities[d].type + '/' + devId + '/' + entities[d].id + '/config';
          mqttClient.publish(dead, '', true);   // retained empty = remove
        } else {
          kept.push(entities[d]);
        }
      }
      console.log('mqtt: not an OLED panel, withheld ' +
                  (entities.length - kept.length) + ' panel entities');
      entities = kept;
    }

    for (var i = 0; i < entities.length; i++) {
      var item = entities[i];
      var conf = item.payload;
      conf.unique_id = devId + '_' + item.id;
      conf.device = devInfo;
      conf.availability_topic = statusTopic;
      conf.payload_available = 'online';
      conf.payload_not_available = 'offline';

      var discTopic = discPfx + '/' + item.type + '/' + devId + '/' + item.id + '/config';
      mqttClient.publish(discTopic, JSON.stringify(conf), true);
    }
    console.log('mqtt: published ' + entities.length + ' Home Assistant discovery entities');
  }

  var lastPicSig = '';
  var lastCapSig = '';

  function publishTelemetry() {
    if (!mqttClient.connected) return;
    mqttClient.publish(statusTopic, 'online', true);
    collectStats(function(s) {
      mqttClient.publish(telemetryTopic, JSON.stringify(s), false);
      MQTT_STATUS.lastPublish = Date.now();
      /*
       * Reconcile the panel switch against what the TV actually reports.
       * It used to be published only when the command arrived over MQTT, so
       * blanking the panel from the dashboard, the remote, or the TV's own
       * menus left Home Assistant asserting the opposite indefinitely.
       * Driving it from powerState makes it self-correcting whatever the
       * change came from.
       */
      if (s.powerState && typeof s.powerState.screenOn === 'boolean') {
        mqttClient.publish(stateScreenTopic, s.powerState.screenOn ? 'ON' : 'OFF', true);
      }
      /*
       * The picture modes a set will accept change with the source's dynamic
       * range, and a select whose options cannot be applied is worse than no
       * select - Home Assistant would offer SDR modes against Dolby Vision
       * content and every one of them would be refused. The options live in
       * the discovery payload, so a changed set means republishing it.
       */
      var sig = ((s.picture && s.picture.modes) || []).map(function (m) {
        return m.value;
      }).join(',');
      if (sig && sig !== lastPicSig) {
        lastPicSig = sig;
        console.log('mqtt: picture modes changed (' + sig + ') - republishing discovery');
        publishDiscovery();
      }
      /*
       * The HDMI diagnostics and the play state only appear once a source has
       * been active, so a set that started on the Home screen looks incapable
       * at first connect. Publishing again each time one of them shows for the
       * first time turns that entity on; nothing is ever unlatched, so this
       * settles rather than flapping.
       */
      var cap = [];
      for (var hs in hdmiSeen) cap.push(hs);
      if (hasMediaState) cap.push('play_state');
      cap = cap.sort().join(',');
      if (cap !== lastCapSig) {
        lastCapSig = cap;
        console.log('mqtt: set reported (' + cap + ') for the first time - republishing discovery');
        publishDiscovery();
      }
    });
  }

  mqttClient.on('connect', function() {
    mqttStatus('connected', '');
    console.log('mqtt: connected to ' + CONFIG.mqtt.host + ':' + mqttClient.opts.port +
                (useTls ? ' (tls)' : ' (plaintext)'));
    mqttClient.publish(statusTopic, 'online', true);
    // Deliberately not asserting a screen state here: publishTelemetry below
    // sets it from what the TV reports. Publishing a retained 'ON' on every
    // reconnect meant a restart silently flipped Home Assistant back to on.
    // Resolve the panel type first: publishDiscovery filters on it, and on a
    // first connect it would otherwise still be undetermined.
    // The app select's options come from listApps, which on a first connect
    // has not been scanned yet - without this it publishes the fallback list.
    detectOled(function () {
      detectLogoLight(function () {
        refreshInstalledApps(function () { publishDiscovery(); });
      });
    });
    mqttClient.subscribe(pfx + '/command/#');
    publishTelemetry();
  });

  mqttClient.on('message', function(topic, payload) {
    var prefix = pfx + '/command/';
    if (topic.indexOf(prefix) !== 0) return;
    var action = topic.substring(prefix.length);
    var val = payload ? payload.trim() : '';
    console.log('mqtt: command received: ' + action + ' -> ' + val);

    if (action === 'screen') {
      var turnOff = (val.toUpperCase() === 'OFF');
      doControl(turnOff ? 'screenOff' : 'screenOn', null, function(r) {
        if (r && r.ok) {
          mqttClient.publish(stateScreenTopic, turnOff ? 'OFF' : 'ON', true);
        }
      });
      return;
    }

    if (action === 'reboot') {
      doControl('reboot', null, function (r) {
        console.log('mqtt: reboot executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'powerOff') {
      doControl('powerOff', null, function (r) {
        console.log('mqtt: powerOff executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'mute') {
      doControl('mute', val.toUpperCase() === 'ON', function (r) {
        console.log('mqtt: mute set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'volume') {
      doControl('volume', num(val, 10), function (r) {
        console.log('mqtt: volume set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'input') {
      doControl('input', val.toLowerCase().replace(/\s+/g, ''), function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'toast') {
      doControl('toast', val, function() {});
      return;
    }

    if (action === 'refresher') {
      var sch = (val.toLowerCase() === 'schedule' || val.toLowerCase() === 'on');
      doControl(sch ? 'refresherSchedule' : 'refresherCancel', null, function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    doControl(action, val, function() {
      setTimeout(publishTelemetry, 400);
    });
  });

  mqttClient.on('error', function(err) {
    mqttStatus('error', err.message);
    console.error('mqtt error:', err.message);
  });

  /* A socket error destroys the socket, so 'close' follows it. The error text
     is the part worth reporting, so it stands until the next connect. */
  mqttClient.on('close', function() {
    if (MQTT_STATUS.state !== 'error') mqttStatus('connecting', 'connection dropped, retrying');
  });

  process.on('SIGTERM', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });
  process.on('SIGINT', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });

  var intervalMs = CONFIG.mqtt.telemetryIntervalMs || 10000;
  setInterval(publishTelemetry, intervalMs);

  mqttClient.connect();
}

/*
 * Liveness marker for the watchdog in tvwebctl.
 *
 * A wedged server keeps its port open and its process alive, so "is it
 * listening" proves nothing: on 2026-09-09 the loop froze inside libuv's
 * spawn path - a forked child deadlocked on a futex before reaching exec, so
 * the parent blocked forever reading the 4-byte exec-error pipe - and the
 * dashboard, MQTT and everything else stopped while the process looked fine.
 * A timer that stops firing is the signal that catches it. /var/run is tmpfs,
 * so this costs no flash writes.
 */
var BEAT_FILE = '/var/run/tvweb.beat';

/* Seconds, not milliseconds: the watchdog is busybox ash, whose arithmetic is
   32-bit, and a 13-digit millisecond stamp overflows it into nonsense. */
function heartbeat() {
  fs.writeFile(BEAT_FILE, String(Math.floor(Date.now() / 1000)), function () {});
}

heartbeat();
setInterval(heartbeat, 20000);

restageScreensaver();

detectDeviceInfo(function() {
  setupHomeAssistant();
});
