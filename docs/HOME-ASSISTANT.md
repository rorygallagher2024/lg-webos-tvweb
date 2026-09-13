# Home Assistant

Entity reference and example automations.

---

## Entities

Once connected to your MQTT broker, Home Assistant automatically discovers **up to 70 native entities** under a single unified device:

### Controls & Switches
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `switch` | `switch.lg_tv_display_panel` | OLED Display Panel | Blanks/turns off OLED panel while audio plays |
| `switch` | `switch.lg_tv_mute` | Mute | Toggle audio mute |
| `switch` | `switch.lg_tv_pixel_refresher_schedule` | Schedule Pixel Refresher | Schedule/cancel 1-hour calibration for next standby |
| `switch` | `switch.lg_tv_ad_blocker` | Ad & Telemetry Blocker | On-TV `/etc/hosts` blackhole for LG ad/tracking domains |
| `switch` | `switch.lg_tv_standby_light` | Standby LED | Toggle standby front indicator LED |
| `switch` | `switch.lg_tv_logo_light` | Logo Light | Toggle front illuminated TV logo |
| `number` | `number.lg_tv_volume` | Volume | Volume slider (0–100) |
| `select` | `select.lg_tv_input_source` | Input Source | HDMI 1–4, Live TV |
| `select` | `select.lg_tv_app` | Launch App | Installed apps (YouTube, Netflix, Prime Video, Spotify, etc.) |
| `select` | `select.lg_tv_picture_mode` | Picture Mode | Switch profiles (ISF Dark/Bright, Cinema, Game, Standard) |
| `select` | `select.lg_tv_sound_output` | Sound Output | Switch outputs (TV Speaker, HDMI ARC, Optical, Headphone) |
| `select` | `select.lg_tv_sleep_timer` | Sleep Timer | Off, 10, 30, 60, 90, 120 minutes |
| `button` | `button.lg_tv_play` | Play | Resume media playback |
| `button` | `button.lg_tv_pause` | Pause | Pause media playback |
| `button` | `button.lg_tv_play_pause` | Play / Pause | Toggle media playback |
| `button` | `button.lg_tv_stop` | Stop | Stop media playback |
| `switch` | `switch.lg_tv_oled_screen_shift` | OLED Screen Shift | Pixel orbiting, on OLED sets |
| `select` | `select.lg_tv_oled_logo_dimming` | OLED Logo Dimming | Local logo dimming: Off, Light, High |
| `select` | `select.lg_tv_screensaver_mode` | Screen Saver | Which screen saver the TV runs: LG default, Clock, Starfield, Fireworks or Panel vitals. Brightness is set on the dashboard's Screensaver tab |
| `button` | `button.lg_tv_screensaver` | Start Screensaver | Starts the webOS screensaver, or dismisses one that is showing |
| `text` | `text.lg_tv_screen_notification` | Screen Notification | Send custom toast messages to TV screen |
| `button` | `button.lg_tv_restart` | Restart TV | Reboots the TV (requires `allowPower: true`) |
| `button` | `button.lg_tv_power_off` | Power Off TV | Powers off the TV (requires `allowPower: true`) |

Playback reaches an HDMI source over CEC, where the TV has only one key for both halves of play/pause. Pause and Play / Pause behave as expected there; Play toggles rather than only resuming. On the built-in apps all four are exact.

### OLED Panel Health (OLED sets only)
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_oled_panel_hours` | OLED Panel Hours | Total cumulative operating hours (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_since_compensation` | OLED Hours Since Short Cycle | Hours elapsed since last 4h compensation (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_compensation` | OLED Hours Until Short Cycle | Hours until next short compensation due (`h`) |
| `sensor` | `sensor.lg_tv_oled_compensation_status` | OLED Compensation Status | `Idle` or `Running` (active panel maintenance) |
| `sensor` | `sensor.lg_tv_oled_hours_since_refresher` | OLED Hours Since Pixel Refresher | Hours elapsed since last 2,000h deep refresher (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_refresher` | OLED Hours Until Pixel Refresher | Hours until next 2,000h deep refresher due (`h`) |
| `sensor` | `sensor.lg_tv_oled_refresher_status` | Pixel Refresher Status | `Idle`, `Scheduled`, or `Running` (2,000h deep cycle) |
| `sensor` | `sensor.lg_tv_oled_short_cycles` | OLED Short Cycles Completed | Lifetime completed Off-RS short compensation cycles |
| `sensor` | `sensor.lg_tv_oled_refresher_cycles` | OLED Refresher Cycles Completed | Lifetime completed JB 2,000-hour deep refresher cycles |
| `sensor` | `sensor.lg_tv_oled_failure_alerts` | OLED Compensation Failures | Total compensation failure alerts recorded on set |
| `binary_sensor` | `binary_sensor.lg_tv_oled_asbl_dimmer` | OLED ASBL Protection | State of Auto Static Brightness Limiter / GSR dimmer |
| `binary_sensor` | `binary_sensor.lg_tv_screen_saver_active` | Screen Saver | Whether a screen saver is on screen now; withheld on sets that do not report it |

### HDMI 2.1 & Live Stream Telemetry
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_video_signal` | Video Signal | HDMI resolution & refresh rate (e.g. `3840x2160 @ 120Hz`) |
| `sensor` | `sensor.lg_tv_hdmi_link_mode` | HDMI Link Mode | Active link rate (e.g. `FRL 48 Gbps (12G 4L)`, `TMDS`) |
| `sensor` | `sensor.lg_tv_hdmi_chroma` | HDMI Chroma Subsampling | Chroma format (e.g. `RGB 4:4:4`, `YCbCr 4:2:2`) |
| `sensor` | `sensor.lg_tv_hdmi_hdcp` | HDMI HDCP Version | HDCP protocol version (e.g. `2.3`, `2.2`, `1.4`) |
| `sensor` | `sensor.lg_tv_hdmi_cable_errors` | HDMI Cable Error Count | Physical cable bit error counter |
| `binary_sensor` | `binary_sensor.lg_tv_hdmi_allm` | HDMI ALLM | Auto Low Latency Mode active status |
| `binary_sensor` | `binary_sensor.lg_tv_hdmi_vrr` | HDMI VRR | Variable Refresh Rate active status |
| `sensor` | `sensor.lg_tv_video_colorimetry` | Video Colorimetry | Color space standard (e.g. `BT.709`, `BT.2020`) |
| `sensor` | `sensor.lg_tv_dynamic_range` | Dynamic Range | **Dolby Vision**, **HDR**, or **SDR** |
| `sensor` | `sensor.lg_tv_picture_mode` | Picture Mode | Current profile (e.g. *Dolby Vision Cinema*, *Game*) |
| `sensor` | `sensor.lg_tv_oled_light` | OLED Light | OLED panel backlight level (`0–100%`) |
| `sensor` | `sensor.lg_tv_panel_dimming` | Panel Dimming | Dynamic backlight/panel dimming state |
| `sensor` | `sensor.lg_tv_audio_output` | Audio Output | Output the audio service is driving (e.g. *HDMI ARC*, *Headphone / AUX*) |
| `sensor` | `sensor.lg_tv_active_app` | Active App | Current foreground app or friendly CEC device |

The six HDMI entities are published per field, and only once the set has
reported that field. An HDMI 2.0 port reports as connected but carries none of
the 2.1 lines, so a 2018 set such as a B8 gets none of them rather than a row
of Unknowns and a cable error count of zero.
| `sensor` | `sensor.lg_tv_play_state` | Player State | State of the TV's own media pipeline (`playing`, `paused`, `stopped`) |

### Hardware, Remote & System Diagnostics
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_remote_battery` | Magic Remote Battery | Battery percentage of paired Magic Remote (`%`) |
| `sensor` | `sensor.lg_tv_soc_architecture` | SoC Architecture | Processor platform (e.g. `Alpha 9 Gen 5 (O22)`) |
| `sensor` | `sensor.lg_tv_oled_cell_type` | OLED Cell ID | Panel silicon cell identification (e.g. `08/00/1/03`) |
| `sensor` | `sensor.lg_tv_tcon_firmware` | TCON Firmware | Timing Controller FPGA firmware version |
| `sensor` | `sensor.lg_tv_soc_temperature` | SoC Temperature | TV processor temperature (`°C`) |
| `sensor` | `sensor.lg_tv_soc_current` | SoC Current | Processor current draw (`mA`, CPU + Core AVS) |
| `sensor` | `sensor.lg_tv_cpu_usage` | CPU Usage | Real-time CPU load (`%`) |
| `sensor` | `sensor.lg_tv_gpu_clock` | GPU Clock | Real-time GPU frequency (`MHz`) |
| `sensor` | `sensor.lg_tv_memory_usage` | Memory Usage | System RAM usage (`%`) |
| `sensor` | `sensor.lg_tv_swap_usage` | Swap Usage | Swap usage (`%`), backed by zram or a flash partition depending on the set |
| `sensor` | `sensor.lg_tv_app_storage_free` | App Storage Free | Available storage on `/media/developer` (`GB`) |
| `sensor` | `sensor.lg_tv_ambient_light` | Ambient Light | Ambient room illuminance (`lux`, if sensor present) |
| `sensor` | `sensor.lg_tv_wifi_signal` | Wi-Fi Signal | Wi-Fi signal strength (`dBm`) |
| `sensor` | `sensor.lg_tv_download_rate` | Download Rate | Live network throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_upload_rate` | Upload Rate | Live network upload throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_flash_health` | Flash Storage Health | eMMC remaining health estimate (`>90% (Healthy)`) |
| `sensor` | `sensor.lg_tv_flash_wear` | Flash Wear Level | JEDEC write-cycle consumption (`0–10%`) |
| `sensor` | `sensor.lg_tv_uptime` | Uptime | TV uptime in seconds |
| `sensor` | `sensor.lg_tv_tvweb_version` | Server Version | Version of this server, not TV firmware (diagnostic) |

---

## Multiple TVs

Each TV on the same broker needs a unique `topicPrefix` and `device.id` in its
config, otherwise they overwrite each other's state and disconnect each other.
See the README for a config example and the `deploy.sh` per-IP config lookup.

---

## Example automations

### 1. Automatically Blank Screen When Playing Music (Spotify / AirPlay)
Save OLED panel hours and eliminate burn-in risk when streaming audio:

```yaml
alias: "TV: Turn Off Screen for Music"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_active_app
    to: "spotify"
    for:
      seconds: 30
condition:
  - condition: state
    entity_id: switch.lg_tv_display_panel
    state: "on"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_tv_display_panel
```

### 2. Dim Cinema Lighting on Dolby Vision Playback
Trigger an ambient lighting scene whenever 4K Dolby Vision playback begins:

```yaml
alias: "Cinema: Dim Lights on Dolby Vision"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_dynamic_range
    to: "Dolby Vision"
action:
  - service: scene.turn_on
    target:
      entity_id: scene.movie_night
```

### 3. Display Doorbell / Security Toast on TV Screen
Display a notification directly on the TV when a doorbell rings:

```yaml
alias: "Notify TV on Doorbell"
trigger:
  - platform: state
    entity_id: binary_sensor.front_doorbell_motion
    to: "on"
action:
  - service: text.set_value
    target:
      entity_id: text.lg_tv_screen_notification
    data:
      value: "Motion detected at front door"
```

---

## Universal Media Player Setup

Home Assistant Core does not offer native MQTT discovery for `media_player` platforms. To group all the discovered volume, mute, power, playback, and source controls into a single native media player card:

Add the following to your `configuration.yaml`:

```yaml
media_player:
  - platform: universal
    name: "LG OLED TV"
    unique_id: lg_oled_tv_media_player
    children: []
    commands:
      turn_on:
        service: wake_on_lan.send_magic_packet
        data:
          mac: "YOUR_TV_MAC_ADDRESS"
      turn_off:
        service: button.press
        target:
          entity_id: button.lg_tv_power_off
      volume_up:
        service: mqtt.publish
        data:
          topic: "lgtv/command/volume"
          payload: "+1"
      volume_down:
        service: mqtt.publish
        data:
          topic: "lgtv/command/volume"
          payload: "-1"
      volume_set:
        service: number.set_value
        target:
          entity_id: number.lg_tv_volume
        data:
          value: "{{ volume * 100 }}"
      volume_mute:
        service: switch.toggle
        target:
          entity_id: switch.lg_tv_mute
      media_play:
        service: button.press
        target:
          entity_id: button.lg_tv_play
      media_pause:
        service: button.press
        target:
          entity_id: button.lg_tv_pause
      media_play_pause:
        service: button.press
        target:
          entity_id: button.lg_tv_play_pause
      media_stop:
        service: button.press
        target:
          entity_id: button.lg_tv_stop
      select_source:
        service: select.select_option
        target:
          entity_id: select.lg_tv_input_source
        data:
          option: "{{ source }}"
    attributes:
      state: switch.lg_tv_display_panel
      is_volume_muted: switch.lg_tv_mute
      volume_level: number.lg_tv_volume
      source: select.lg_tv_input_source
      source_list: select.lg_tv_input_source|options
```

---

## Wake-on-LAN (WoL) Setup

When the TV enters standby mode, the Linux kernel and Node daemon shut down. To turn the TV on directly from Home Assistant:

1. Enable **LG QuickStart+** on the TV:
   * **Settings &rarr; General &rarr; Quick Start+ &rarr; On**
2. Enable **Mobile TV On / Turn on via Wi-Fi/LAN**:
   * **Settings &rarr; General &rarr; Mobile TV On &rarr; Turn on via Wi-Fi** (or Wired)
3. In Home Assistant, add the `wake_on_lan` integration to your `configuration.yaml`:
   ```yaml
   wake_on_lan:
   ```
4. Now the `wake_on_lan.send_magic_packet` action will wake the TV from deep standby.

