# Implementation notes

How this works on the inside, and the platform quirks that shaped it. Nothing
here is needed to use the project - see the [README](../README.md) for that.

---

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │          LG webOS TV (Rooted)           │
                  │              (Node 0.12)                │
                  │  ┌───────────────────┐ ┌─────────────┐  │
                  │  │ HTTP Dashboard UI │ │  MiniMQTT   │  │
                  │  │ (Port 8080)       │ │  Client     │  │
                  │  └─────────┬─────────┘ └──────┬──────┘  │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   In-Flight Concurrency Mutex & Caching │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   Direct execFile (luna-send -w 2000)   │
                  │      webOS Luna Bus & /proc telemetry   │
                  └───────────────────────────────┬─────────┘
                                                  │
                                    MQTT TCP 1883 │ (Telemetry + Controls)
                                                  ▼
                  ┌─────────────────────────────────────────┐
                  │          MQTT Broker / Mosquitto        │
                  └───────────────────────┬─────────────────┘
                                          │
                                          ▼
                  ┌─────────────────────────────────────────┐
                  │              Home Assistant             │
                  │      (Auto-Discovered Entities)         │
                  └─────────────────────────────────────────┘
```

### High-Stability Process Execution
Older Linux kernels and Node 0.12 can encounter process deadlocks or child leaks when `child_process.exec()` is called frequently (spawning `/bin/sh` without timeout parameters). 

`tvweb.js` solves this with:
1. **Direct `execFile`**: Invokes `/usr/bin/luna-send` directly with zero shell overhead.
2. **Internal Daemon Timeout**: Luna calls use `-w 2000` to prevent orphaned background processes if a system bus stalls.
3. **In-Flight Concurrency Mutex**: If multiple HTTP pollers or MQTT intervals request stats simultaneously, they are coalesced into a single execution pipeline.
4. **Memory Caching**: Telemetry is cached for 1.5 seconds, delivering sub-20ms HTTP responses with zero subprocess spawning during rapid UI updates.
5. **Deterministic MQTT Client Session**: Uses a static client ID and periodic availability reaffirmation so TV reboots or network reconnects never leave entities trapped in an "Unavailable" state.

---

---

## Platform constraints

- **Node.js v0.12 (2015)**: webOS 4.x ships Node v0.12.2. All code in `tvweb.js` is written in strict ES5 (no `let`/`const`, no arrow functions, no template literals, no `async`/`await`).
- **BusyBox `run-parts` Hook Naming**: The webosbrew startup system invokes user hooks with `run-parts /var/lib/webosbrew/init.d`. BusyBox `run-parts` strictly ignores any filename containing a dot (`.`), so the boot hook must be named `50-tvweb` without `.sh`.
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`, `com.webos.service.settings`, `com.webos.service.eim`).

---

---

## eMMC health vs wear

Under the **JEDEC eMMC 5.0** specification, `/sys/block/mmcblk0/device/life_time` returns byte estimates for SLC and MLC partition write cycles:
- `0x01` indicates **0% – 10% of rated device write cycles used**.
- This means **>90% of drive life remains** (Healthy).
- `pre_eol_info` returning `01` indicates normal endurance (<80% reserved blocks consumed).

To prevent user confusion, `tvweb.js` translates this into both a human-friendly health state (`>90% (Healthy)`) and a wear estimate (`0-10% used · Normal EOL`).

---

---

## Where the telemetry comes from

webOS 4.x has **no generic Linux thermal interface**. `/sys/class/thermal` exists
but is empty, and there is no `hwmon` at all, so any guide pointing at
`thermal_zone*/temp` returns nothing on this hardware. LG exposes its own tree
instead:

| Path | Meaning |
| :--- | :--- |
| `/proc/lg/pm/temperature` | SoC temperature, **plain °C** (not millidegrees) |
| `/proc/lg/pm/current_load` | CPU load, % |
| `/proc/lg/pm/frequency` | kHz |
| `/proc/lg/pm/status` | per-core load, governor, AVS currents |
| `/sys/block/mmcblk0/device/life_time` | eMMC wear (`0x01` = 0–10% used) |
| `/sys/block/mmcblk0/device/pre_eol_info` | `01` Normal / `02` Warning / `03` Urgent |
| `/mnt/lg/cmn_data/mrcu/mrcu1.info` | Magic Remote battery percentage, remote model, BDAddr, and firmware |
| `/proc/lg/hdmi20/port[0-3]/status` | Real-time HDMI receiver PHY mode (FRL 48 Gbps vs TMDS), chroma (RGB 4:4:4), HDCP, cable error counter, ALLM, VRR |
| `/proc/lg/pe/hdr_status` | Picture engine live video format, colorimetry standard (`BT.709`, `BT.2020`), and peak nit levels |
| `/var/luna/preferences/environmentCondition` | Hardware configuration (SoC generation `_O22_`, DDR RAM, refresh rate, eye sensor) |

**Do not read `/proc/lg/pm/ts_enable`** — it segfaults the reading process.

webOS 3.9 has no temperature source at all: `/proc/lg/pm/temperature` is absent,
nothing under `/proc/lg` or `/sys` is named for temperature, `/sys/class/thermal` is
empty, there is no `hwmon`, and `systemproperty` rejects every temperature key. The
server reports this as `capabilities.thermal: false` so the dashboard can distinguish
it from the ~80s post-boot window where the file exists but reads 0.

### /proc/stat is not monotonic

LG hot-plugs CPU cores (`/proc/lg/pm/mp_enable`), so the aggregate counters in
`/proc/stat` can go *backwards* between samples — the idle figure has been
observed dropping from 324186 to 228324 across two reads seconds apart. Any
delta-based CPU percentage built on it produces nonsense. `current_load` is the
figure to trust; `/proc/stat` is only used when every delta is non-negative.

## OLED panel counters, and their units

The panel timers do not share a unit, which is the single easiest thing to get
wrong here. Furthermore, webOS 9+ (webOS 22+, e.g. LG C2) moved several counters
to a dedicated service and changed filesystem file paths:

| Value | Older webOS (B8, 4.x–8.x) | Modern webOS (C2, 9.x / 22+) | Unit |
| :--- | :--- | :--- | :--- |
| **Panel usage time** | `com.webos.service.tv.systemproperty/getSystemProperties` (`panelUsageTime`) | `com.webos.service.panelcontroller/getPanelUsageTime` (`panelUsageTime`) | 10-minute units — divide by 6 for hours |
| **Last compensation** | `lastCompensationTimestamp` (Luna) | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | 10-minute units (Luna) / whole hours (fs) |
| **Off-RS hours (fs)** | `/mnt/lg/cmn_data/pnwash/autoOffRsTime` | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | whole panel **hours** |
| **Refresher hours (fs)**| `/mnt/lg/cmn_data/pnwash/autoPnwashTime` | `/mnt/lg/cmn_data/pnwash/autoJbLastTime` | whole panel **hours** |
| **Off-RS interval** | `/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode` (`24`) | `/mnt/lg/cmn_data/pnwash/autoOffRsInterval` (`4`) | 10-min units (older) / whole hours (newer) |
| **Refresher cadence** | Constant (2,000h) | `/mnt/lg/cmn_data/pnwash/autoJbInterval` (`2000 ok`) | whole panel **hours** |
| **Off-RS completed cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedOffRsCount` | integer count |
| **JB refresher cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedJbCount` | integer count |
| **Compensation failures** | &mdash; | `/mnt/lg/cmn_data/pnwash/failAlertCount` | integer count |
| **Panel silicon info** | &mdash; | `com.webos.service.panelcontroller/getOledCellInfo` / `getOledTconInfo` | Cell ID & TCON FPGA FW |

On older sets, the interval file reading `24` means four hours, matching LG's documented
cumulative-viewing cycle — not twenty-four. It is expressed in the same 10-minute units as
the Luna counters it gets compared against, while `autoOffRsTime` alongside it is in
hours. Confirmed on a live set: `autoOffRsTime` 3426 against a `panelUsageTime`
of 20576 (÷6 = 3429).

On webOS 9+ sets, `autoOffRsInterval` is expressed directly in whole hours (`4`),
`autoJbInterval` reports `2000 ok`, and `panelcontroller/getPanelUsageTime` provides
the live usage counter in 10-minute units. Confirmed on an LG C2: `autoOffRsLastTime` 4767
against a `panelUsageTime` of 28614 (÷6 = 4769).

## Panel detection

Panel-lifecycle features are gated on panel type, detected once via
model name matching (`OLED...`), `/var/luna/preferences/paneltype_oled`, pnwash filesystem
records, or a `panelUsageTime` query that actually responds. On an LCD/QNED set they are
omitted from the dashboard and withheld from MQTT discovery, with retained discovery configs
cleared so they do not linger in Home Assistant as orphans. Reporting `0 hours` would read as a real
measurement.

## Deploying over ssh

Two things bite when moving off telnet, both because an inline `ssh` command
becomes the remote shell's own `argv`:

- **`pkill -f tvweb.js` kills the shell running it.** Its command line contains
  that path, so it matches itself. The bracket trick does not save you either,
  since the path appears again in the start command. Hence `tvwebctl`: inside a
  script file the shell's argv is just the script.
- **`setsid ... &` does not detach.** The child inherits the ssh session's stdin
  and dies when the connection closes — the server starts, publishes discovery,
  then vanishes. `start-stop-daemon -b -m` survives.

`rsync` ships with the Homebrew Channel but is broken on-device: it cannot load
`libcrypto.so.1.1`. Use `scp`, which works over the sftp subsystem.

## Fonts

The dashboard bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
[Manrope](https://github.com/sharanda/manrope) as variable fonts, both under the
SIL Open Font License, served by the TV so the page needs no internet access.
Licence texts ship alongside them in `server/assets/fonts/`.

---

## Consent flags are rebuilt from LG's agreement documents at boot

`/var/luna/preferences/eula` is a mirror. `com.webos.settingsservice` holds the
values under the `eulaStatus` key and regenerates the file, and its `eula.md5`
sidecar, at boot - so editing the file directly reverts. Flipping
`thirdPartySharingAllowed` in the file survived inspection, the dashboard and 75
seconds of runtime, then came back byte-identical after a reboot (md5
`85aca988...`, mtime set during boot).

Writing through the service works, but the flag alone does not survive a boot.

`eulaStatus` is derived from a second record: `eulaInfoNetwork`, LG's agreement
documents with an accepted flag on each. At boot the firmware rebuilds every
mapped flag from the accepted documents, so a flag written on its own is
overwritten by whatever its agreement still says. Reported on a C8 (webOS 4.4.0)
in [#61](https://github.com/rorygallagher2024/lg-webos-mqtt/issues/61).

**Both firmwares rebuild.** An earlier note here said a B8 on 4.4.3 did not, on
the strength of `cookiesAllowed` surviving a reboot. That flag is absent from
`eulaMappingList`, so the rebuild never touches it - the one flag that was
exempt, generalised to all of them. Measured properly on the same B8:

| Write | After a reboot |
| :--- | :--- |
| `thirdPartySharingAllowed` false, document left accepted | back to `true` |
| the same flag through the panel, withdrawing `S_ADG` | still `false` |

So a write has to move both records. Switching a flag on accepts the documents
it needs; switching it off withdraws those no remaining flag requires, and any
flag resting on one goes off with it. A document needed by a flag that cannot
be switched off is never withdrawn, which is what keeps Terms of Use in place.

Several flags share one document, so they can only be switched off together.
The panel names them before they are clicked.

`eulaInfoNetwork` also carries the document titles - `S_ADG` is the "Viewing
Information Agreement" - and is the only place on the set that names them. The
file that caches it does not exist on webOS 9, so it is read from the service.

Two quirks. `getSystemSettings` answers for `eulaStatus` only when no `category`
is given - `general`, `option` and the rest return "There is no matched result
from DB". And the setter takes the whole `eulaStatus` object, so changing one
flag is a read-modify-write.

A flag that sticks still only records what the TV stored. It does not prove LG
honours it, and the value may be mirrored against the account server-side.

`returnValue: true` is the service accepting the call, not evidence it stored
anything - writing the file directly looks exactly as successful. Every write
from the panel is read back before it reports success, so a set where the
setter is a no-op says so rather than showing a toggle that has not moved.

Which flags exist varies: a B8 on 4.4.3 has 21, a C2 on 9.2.2 has 23, including
`marketingOnAllowed`, `shoppingOnAllowed` and `takeOnAllowed`, and no
`allAllowed`. `eulaMappingList` differs too - `additional1Allowed` is in a group
on 4.4.3 and in none on 4.4.0. Nothing about the set is hardcoded for that
reason: the mapping decides which flags the panel will write, and a TV that
publishes no mapping gets no toggles on undescribed flags at all.

## luna-send prints nothing without a tty

Over a non-interactive ssh command it returns an empty string and exit 0, which
reads as a call that succeeded silently. Use `ssh -tt`. Calls made by `tvweb.js`
on the TV itself are unaffected - this bites when testing by hand, and it is an
easy way to convince yourself a change worked when nothing ran.

## tvpower reboot does not reboot

`luna://com.webos.service.tvpower/power/reboot` accepts the request, validates
its parameters (omitting `reason` returns `errorCode -7`) and reports success -
but the kernel never restarts. Measured on an OLED65B8SLC running webOS 4.4.3:

| | uptime |
| :--- | :--- |
| before the call | 12810s |
| after (set was off the network ~65s) | 12871s |

It behaves like a standby transition. `/sbin/reboot` performs a real restart:
uptime reset to 60s, with services and the webosbrew boot hook all returning
cleanly. The reboot control therefore uses the kernel path, replying to the
client first because the process is about to go down with the system.

## The thermal sensor lags boot

`/proc/lg/pm/temperature` reads a literal `0` for roughly the first 80 seconds
after a restart - valid at 83s uptime on the test set, still `0` at 73s. That
is not a measurement, so it is reported as `null`, kept out of the history ring
buffer, and shown as a dash. Publishing it would put a false 0&deg;C spike into
Home Assistant's history on every reboot.

---

## The blocker's second tier takes LG's own platform with it

The blocklist is applied by bind-mounting a generated hosts file over
`/etc/hosts`, which is the only way to change it on a read-only rootfs - the
same technique webosbrew uses for `/etc/shadow` and `/etc/motd`. Verified
working: `getent hosts ad.lgsmartad.com` returns `0.0.0.0`.

Nine of the nineteen domains are ad, tracking and diagnostics hosts that
nothing on the TV needs. The other ten are **LG infrastructure rather than
advertising**, which is why they are a separate tier:

| Domain | What it actually serves |
| :--- | :--- |
| `ngfts.lge.com`, `aic-ngfts.lge.com` | Content and firmware delivery CDN |
| `lgtvsdp.com` (and `us.`/`gb.`/`eu.`) | Service platform behind the Content Store on webOS 4 |
| `nextlgsdp.com` (and `us.`/`gb.`/`eu.`) | The same on webOS 9 |

`com.webos.appInstallService` names the one its own set installs from:
`http://GB.lgtvsdp.com` on a B8, `http://GB.nextlgsdp.com` on a C2. The full
tier adds whatever that file says, so a firmware using neither is still covered.

Blocking them is a defensible choice, but it means **firmware updates and the
app store may stop working** on that tier. Anyone who turns it on and later
finds the Content Store broken will not connect the two events unless told, so
it is stated at the control in the UI as well as here.

## Entity state must come from the TV, not from the command

Entities derive state from the telemetry payload via a `value_template`, so
they re-assert the truth on every tick whatever changed it - dashboard, remote,
the TV's own menus, or Home Assistant.

The display panel switch originally published only when a command arrived over
MQTT, plus a retained `ON` on every connect. Blanking the panel from the
dashboard left Home Assistant showing it on indefinitely. It is now reconciled
against `powerState` each telemetry publish.

So: prefer `state_topic: telemetryTopic` with a template. An entity on its own
topic must be republished from real state every tick, or it is a guess that
holds until someone notices.

`scripts/check-entities.py` resolves every entity's `value_json` paths against a
live `/api/stats`. A renamed field otherwise leaves an entity at `unknown` with
no error anywhere.

---

## The checks

`scripts/` holds four static checks. Three need nothing but the repository and
run in CI; `check-entities.py` needs a live `/api/stats`, so it is run by hand
against the set.

| Check | What it catches |
| :--- | :--- |
| `check-es5.py` | An ES6 construct in `tvweb.js`. Node 0.12 treats one as a parse error, so the server never starts and logs nothing. |
| `check-ui-ids.py` | An id the dashboard reaches for that no element defines. |
| `check-screensavers.py` | QML newer than the `import QtQuick` line it declares. |
| `check-entities.py` | An entity template naming a field the telemetry no longer has. |

`check-es5.py` blanks strings, comments and regex literals before scanning, and
checks syntax only: an ES6 library call parses and fails at the call, which the
log shows, while a parse error leaves no process to log anything.
