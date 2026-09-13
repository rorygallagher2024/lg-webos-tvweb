#!/usr/bin/env python3
"""
tvmon - live monitor for a rooted LG webOS TV.
Verified against OLED65B8SLC, webOS 4.4.3, kernel 4.4.84 (glacier / m16pc0).

Reads LG's private /proc/lg/pm/* nodes plus Luna services over the Homebrew
Channel root telnet. Stdlib only.

    ./tvmon.py <ip> [--interval 1.5] [--slow-every 8]

Platform notes worth knowing:
  * /sys/class/thermal is EMPTY on this hardware. Temperature comes from
    /proc/lg/pm/temperature and is plain degrees C (do NOT divide by 1000).
  * /proc/stat is NOT monotonic here: LG hot-plugs CPU cores, so aggregate
    counters go backwards. LG's own current_load is the trustworthy figure.
"""

import socket, sys, time, re, argparse, signal
import probe_defs as P

MARK_A, MARK_B = "<<<TVMON", "TVMON>>>"

RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
RED, YEL, GRN, CYA, MAG = "\033[31m", "\033[33m", "\033[32m", "\033[36m", "\033[35m"
SPARK = "▁▂▃▄▅▆▇█"


def strip_iac(buf: bytes) -> bytes:
    """Drop telnet IAC negotiation sequences without replying to them."""
    out, i = bytearray(), 0
    while i < len(buf):
        if buf[i] == 255:
            if i + 1 < len(buf) and buf[i + 1] in (251, 252, 253, 254):
                i += 3; continue
            i += 2; continue
        out.append(buf[i]); i += 1
    return bytes(out)


class TV:
    def __init__(self, host, port=23, timeout=8.0):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock = None

    def connect(self):
        self.close()
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock = s
        # Drain the banner with a SHORT timeout. Using the full socket timeout
        # here costs a wasted timeout-length stall on every connect, because
        # the last recv always blocks until it expires.
        s.settimeout(0.4)
        time.sleep(0.5)
        for _ in range(4):
            try:
                if not s.recv(65536):
                    break
            except socket.timeout:
                break
        # The pty echoes what we send, and the echo contains our markers.
        # Killing echo (and the prompt) keeps the parser honest.
        s.sendall(b"stty -echo 2>/dev/null; PS1=''; unset PROMPT_COMMAND\n")
        time.sleep(0.3)
        for _ in range(4):
            try:
                if not s.recv(65536):
                    break
            except socket.timeout:
                break
        s.settimeout(self.timeout)

    def close(self):
        if self.sock:
            try: self.sock.close()
            except OSError: pass
            self.sock = None

    def poll(self, slow=False):
        if not self.sock:
            self.connect()
        self.sock.sendall((P.FAST + (P.SLOW if slow else "") + P.END).encode())
        buf, deadline = b"", time.time() + self.timeout
        while time.time() < deadline:
            try: chunk = self.sock.recv(65536)
            except socket.timeout: break
            if not chunk: raise ConnectionError("connection closed")
            buf += chunk
            if MARK_A.encode() in buf and MARK_B.encode() in buf:
                break
        text = strip_iac(buf).decode("utf-8", "replace").replace("\r", "")
        if MARK_A not in text or MARK_B not in text:
            raise ConnectionError("incomplete response")
        d = {}
        for line in text.split(MARK_A)[-1].split(MARK_B)[0].splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                d[k.strip()] = v.strip()
        return d


# ---------- formatting helpers ----------

def col(v, warn, crit):
    return RED if v >= crit else (YEL if v >= warn else GRN)

def bar(pct, width=28, warn=101, crit=101):
    pct = max(0.0, min(100.0, pct))
    f = int(round(pct / 100 * width))
    return col(pct, warn, crit) + "█" * f + DIM + "·" * (width - f) + RESET

def spark(h, width=46):
    if not h: return ""
    h = h[-width:]
    lo, hi = min(h), max(h)
    rng = (hi - lo) or 1
    return "".join(SPARK[min(7, int((v - lo) / rng * 7.99))] for v in h)

def hhmm(s):
    s = int(s); d, r = divmod(s, 86400); h, r = divmod(r, 3600)
    return (f"{d}d " if d else "") + f"{h}h {r//60}m"

def mb(kbytes):
    return f"{kbytes/1024:,.0f} MB"

def jget(blob, key):
    m = re.search(r'"%s":"([^"]*)"' % key, blob or "")
    return m.group(1) if m else None

def emmc_life(raw):
    """eMMC5.0 DEVICE_LIFE_TIME_EST: 0x01 = 0-10% of rated cycles used."""
    if not raw: return None
    vals = []
    for tok in raw.split():
        try: n = int(tok, 16)
        except ValueError: continue
        if n == 0: continue
        vals.append(">100%" if n >= 0x0B else f"{(n-1)*10}-{n*10}%")
    return " / ".join(vals) if vals else None

EOL = {"01": ("Normal", GRN), "02": ("WARNING - 80% reserve used", YEL),
       "03": ("URGENT - 90% reserve used", RED)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("host")
    ap.add_argument("--interval", type=float, default=1.5)
    ap.add_argument("--slow-every", type=int, default=8,
                    help="run Luna/eMMC queries every Nth poll (they are slower)")
    a = ap.parse_args()

    tv = TV(a.host)
    t_hist, l_hist, cache = [], [], {}
    prev_stat = prev_net = None
    ok = 0

    signal.signal(signal.SIGINT, lambda *_: (sys.stdout.write("\033[?25h\n"), sys.exit(0)))
    sys.stdout.write("\033[?25l\033[2J")

    while True:
        try:
            d = tv.poll(slow=(ok % a.slow_every == 0))
            cache.update({k: v for k, v in d.items() if v})
            err, ok = None, ok + 1
        except Exception as e:
            err = str(e) or e.__class__.__name__
            tv.close()

        o = ["\033[H"]
        if err:
            o.append(f"{BOLD}{CYA}┌ LG TV · {a.host} {RESET}\033[K\n\033[K\n")
            o.append(f"{RED}  ✖  unreachable — {err}{RESET}\033[K\n")
            o.append(f"{DIM}     TV is most likely powered off. Retrying…{RESET}\033[K\n\033[J")
            sys.stdout.write("".join(o)); sys.stdout.flush()
            time.sleep(3.0); continue

        d = cache
        temp = int(d.get("temp") or 0)
        lgload = int(d.get("load") or 0)
        freq = int(d.get("freq") or 0) // 1000
        t_hist.append(temp); l_hist.append(lgload)
        del t_hist[:-300], l_hist[:-300]

        # /proc/stat, guarded against core hot-plug making counters go backwards
        cpu_stat = None
        parts = (d.get("stat") or "").split()[1:]
        if len(parts) >= 4:
            cur = [int(x) for x in parts]
            if prev_stat and len(prev_stat) == len(cur):
                dt = [c - p for c, p in zip(cur, prev_stat)]
                if all(x >= 0 for x in dt) and sum(dt) > 0:
                    cpu_stat = (sum(dt) - dt[3]) / sum(dt) * 100
            prev_stat = cur

        model = jget(d.get("pic"), "modelName") or "TV"
        head = f" LG {model} · {a.host} "
        o.append(f"{BOLD}{CYA}┌{head}{'─'*max(0,58-len(head))}┐{RESET}\033[K\n")

        state = jget(d.get("power"), "state") or "?"
        app = (jget(d.get("app"), "appId") or "?").replace("com.webos.app.", "")
        pmode = jget(d.get("pic"), "pictureMode") or "?"
        drange = jget(d.get("pic"), "dynamicRange") or ""
        sc = GRN if state == "Active" else YEL
        hdr = f"  {MAG}{drange}{RESET}" if drange and "dolby" in drange.lower() else f"  {DIM}{drange}{RESET}"
        o.append(f"  {sc}●{RESET} {state}   {BOLD}{app}{RESET}   {DIM}{pmode}{RESET}{hdr}\033[K\n\033[K\n")

        o.append(f"{BOLD}  TEMP {RESET}{col(temp,60,75)}{BOLD}{temp:4d}°C{RESET} {bar(temp,28,60,75)}\033[K\n")
        o.append(f"{DIM}       {spark(t_hist)}{RESET}\033[K\n")
        if t_hist:
            o.append(f"{DIM}       min {min(t_hist)}°  max {max(t_hist)}°  ({len(t_hist)} samples){RESET}\033[K\n")
        o.append("\033[K\n")

        o.append(f"{BOLD}  CPU  {RESET}{col(lgload,60,85)}{BOLD}{lgload:4d}%{RESET}  {bar(lgload,28,60,85)}\033[K\n")
        o.append(f"{DIM}       {spark(l_hist)}{RESET}\033[K\n")
        st = f"{cpu_stat:.0f}%" if cpu_stat is not None else "n/a"
        o.append(f"{DIM}       {freq} MHz  ·  /proc/stat {st}{RESET}\033[K\n")
        cores = [c for c in (d.get("cores") or "").split() if c.isdigit()]
        if cores:
            o.append("       " + "  ".join(
                f"{DIM}c{i}{RESET} {col(int(c),60,85)}{int(c):3d}%{RESET}"
                for i, c in enumerate(cores)) + "\033[K\n")
        o.append("\033[K\n")

        mt = int((d.get("MemTotal") or "0kB").rstrip("kB") or 0)
        ma = int((d.get("MemAvailable") or "0kB").rstrip("kB") or 0)
        st_ = int((d.get("SwapTotal") or "0kB").rstrip("kB") or 0)
        sf = int((d.get("SwapFree") or "0kB").rstrip("kB") or 0)
        if mt:
            mp = (mt - ma) / mt * 100
            o.append(f"{BOLD}  MEM  {RESET}{col(mp,75,90)}{BOLD}{mp:4.0f}%{RESET}  {bar(mp,28,75,90)}\033[K\n")
            o.append(f"{DIM}       {mb(mt-ma)} used · {mb(ma)} available of {mb(mt)}{RESET}\033[K\n")
        if st_:
            sp = (st_ - sf) / st_ * 100
            o.append(f"{BOLD}  SWAP {RESET}{col(sp,40,70)}{BOLD}{sp:4.0f}%{RESET}  {bar(sp,28,40,70)}\033[K\n")
            o.append(f"{DIM}       {mb(st_-sf)} of {mb(st_)} (zram){RESET}\033[K\n")
        o.append("\033[K\n")

        # network: signal + throughput
        w = (d.get("wifi") or "").split()
        if len(w) >= 4:
            link = w[2].rstrip("."); lvl = int(float(w[3]))
            q = int(float(link)) if link.replace(".", "").isdigit() else 0
            lc = GRN if lvl > -60 else (YEL if lvl > -72 else RED)
            o.append(f"{BOLD}  NET  {RESET}{DIM}wlan0{RESET}  {lc}{lvl} dBm{RESET} {DIM}(link {q}){RESET}")
        rate = ""
        for seg in (d.get("net") or "").split(";"):
            f = seg.split()
            if len(f) >= 10 and f[0].startswith("wlan0"):
                rx, tx, now = int(f[1]), int(f[9]), time.time()
                if prev_net:
                    dt = now - prev_net[2]
                    if dt > 0 and rx >= prev_net[0]:
                        rate = (f"   ↓ {(rx-prev_net[0])/dt/1024:6.0f} KB/s"
                                f"   ↑ {(tx-prev_net[1])/dt/1024:5.0f} KB/s")
                prev_net = (rx, tx, now)
        o.append(f"{DIM}{rate}{RESET}\033[K\n")

        life = emmc_life(d.get("emmc_life"))
        eol, ec = EOL.get((d.get("emmc_eol") or "").strip(), ("?", DIM))
        if life:
            o.append(f"{BOLD}  FLASH{RESET} {DIM}eMMC wear{RESET} {GRN}{life}{RESET}"
                     f" {DIM}used · {RESET}{ec}{eol}{RESET}\033[K\n")
        o.append("\033[K\n")

        la = " ".join((d.get("loadavg") or "").split()[:3])
        o.append(f"{DIM}  load {la}   up {hhmm(d.get('uptime') or 0)}   {d.get('procs','?')} procs{RESET}\033[K\n")
        avs = re.findall(r"(\w+)avs_current\(mA\):(\d+)",
                         f"{d.get('cpuavs','')} {d.get('coreavs','')}")
        if avs:
            o.append(f"{DIM}  " + "   ".join(f"{k} {v} mA" for k, v in avs) + f"{RESET}\033[K\n")
        o.append("\033[K\n")

        o.append(f"{BOLD}{MAG}  top processes{RESET}\033[K\n")
        for e in [x for x in (d.get("top") or "").split("|") if x.strip()][:5]:
            f = e.split()
            if len(f) >= 2:
                o.append(f"{DIM}    {int(f[0])/1024:6.1f} MB  {' '.join(f[1:])}{RESET}\033[K\n")

        o.append(f"\033[K\n{DIM}  {time.strftime('%H:%M:%S')} · {ok} polls · ctrl-c to quit{RESET}\033[K\n\033[J")
        sys.stdout.write("".join(o)); sys.stdout.flush()
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
