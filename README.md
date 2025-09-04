# FreePBX to OpenAI Realtime Community Edition
forked from infinitocloud/asterisk_to_openai_rt_community

Welcome! This Node.js application integrates FreePBX 17 (Debian) with the OpenAI Realtime API to provide a voice-based virtual assistant for SIP calls. It processes audio in real-time and displays user and assistant transcriptions in the console. 

---

## Features
- Real-time audio processing with Asterisk and OpenAI.
- Console transcriptions for user and assistant speech; conversations saved as text files in the Asterisk recordings path.
- Clean resource management (channels, bridges, WebSocket, RTP).
- Configurable via `config.conf` (e.g., API key, prompt).
- **Assistant-triggered Queue Handoff**: when the **assistant** says a configured phrase, the active call is transferred to a FreePBX Queue (e.g., L1 support).
- **Assistant-triggered Call Termination**: when the **assistant** says a configured farewell phrase, the call is cleanly terminated (WS, RTP, bridges, channels).

---

## Requirements
| Category    | Details                                                                 |
|-------------|-------------------------------------------------------------------------|
| OS          | Debian 13                                                               |
| Software    | FreePBX 17 (install on debian 12 and upgrade)                                                            |
| Network     | Ports: 8088 (ARI), 12000+ (RTP) <br> - Access to `wss://api.openai.com/v1/realtime` |
| Credentials | OpenAI API key (`OPENAI_API_KEY`) — prepare it **before** installing |

---

## Installation
1) Log in as root (or use sudo):
```bash
cd /root
```

2) Download the installer script:
```bash
curl -fsSL -o autoinstall_asterisk_to_openai.sh   https://raw.githubusercontent.com/maladrill/asterisk_to_openai_rt_community/main/autoinstall_asterisk_to_openai.sh
```

3) Make it executable **and run** (have your OpenAI key ready, the script will ask for it):
```bash
chmod +x autoinstall_asterisk_to_openai.sh
bash autoinstall_asterisk_to_openai.sh
```

4) Edit configuration:
```bash
nano /opt/asterisk_to_openai_rt_community/config.conf
```
Change what you need:
- `SYSTEM_PROMPT` — instruction for the assistant
- `OPENAI_VOICE` — voices: `alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar`
- `TRANSCRIPTION_LANGUAGE` — supported: `af, ar, hy, az, be, bs, bg, ca, zh, hr, cs, da, nl, en, et, fi, fr, gl, de, el, he, hi, hu, is, id, it, ja, kn, kk, ko, lv, lt, mk, ms, mr, mi, ne, no, fa, pl, pt, ro, ru, sr, sk, sl, es, sw, sv, tl, ta, th, tr, uk, ur, vi, cy`
- `RECORDINGS_DIR` — where transcriptions are stored (default `/var/spool/asterisk/monitor`, saved as `RECORDINGS_DIR/YYYY/MM/DD/...`)

---

## Assistant-triggered Handoff & Call Termination

### What it does
- **Handoff to Queue**  
  When the **assistant** says one of the configured handoff phrases (e.g., _“Okay, connecting you to the technical department”_), the app:
  1. Stops playback/streams,
  2. Closes the OpenAI WebSocket,
  3. Tears down the ExternalMedia bridge,
  4. Continues the live SIP channel in the dialplan at `ext-queues,<REDIRECTION_QUEUE>,1`.

- **Call Termination**  
  When the **assistant** says one of the configured goodbye phrases (e.g., _“goodbye”_), the app:
  1. Cleans up timers and streams,
  2. Closes the WebSocket,
  3. Hangs up channels and frees RTP ports.

### How to configure
Add these to `config.conf` (examples below use English; you can localize them):

```ini
# Redirect to a Queue when the ASSISTANT says any of these phrases
# Quotes are required; commas separate phrases.
REDIRECTION_PHRASES="'Okay, connecting you to the technical department','Thank you, connecting you to a representative'"

# Queue extension (FreePBX Queue number)
REDIRECTION_QUEUE=3000

# Terminate the call when the ASSISTANT says any of these phrases
AGENT_TERMINATE_PHRASES="'goodbye','farewell'"
```

> **Notes**
> - Matching is case-insensitive and normalized; punctuation at the end of a phrase is tolerated.
> - Handoff/termination trigger only on **assistant** transcripts (not on user speech).
> - Internal flags prevent double actions (no duplicate transfers/hangups).

### What you’ll see in logs
```text
[INFO] Assistant redirect phrase matched ("okay, connecting you to the technical department") for <CHAN>; requesting queue handoff
[INFO] Redirection requested for <CHAN> to queue 3000 (trigger="...")
[INFO] Channel <CHAN> continued to ext-queues,3000,1

[INFO] Assistant termination phrase matched ("goodbye") for <CHAN>; cleaning up call
```

---

## FreePBX GUI: Route calls to the custom dialplan (9999)

**Option A — Quick test from any internal phone**
```text
Dial: 9999     (context: from-internal)
```

**Option B — Create a Custom Destination and a Misc Application**
1) Admin → Custom Destinations → Add
- Custom Destination: `from-internal-custom,9999,1`  
- Description: `OpenAI Realtime (9999)`  
- Return: `No`  
- **Submit**, then **Apply Config**

![Screenshot](https://github.com/maladrill/asterisk_to_openai_rt_community/blob/main/custom_destinations.png)

2) Applications → Misc Applications → Add
- Description: `OpenAI Realtime`  
- Feature Code: `*9999` (or `9999` if you prefer)  
- Destination: `Custom Destinations → OpenAI Realtime (9999)`  
- **Submit**, then **Apply Config**

**Option C — Inbound Route → Destination**
- To point an external DID to the app:  
  Connectivity → Inbound Routes → (pick your DID)  
  Set **Destination**: `Custom Destinations → OpenAI Realtime (9999)`  
  **Submit**, then **Apply Config**

**Notes**
- We use only `*_custom.conf` files (`http_custom.conf`, `ari_general_custom.conf`, `ari_additional_custom.conf`).
- We do **not** edit `ari.conf` or `http.conf` (they are FreePBX-generated).
- The app reads config from `/opt/asterisk_to_openai_rt_community/config.conf`.

---

## Usage

Make a SIP call to your configured extension (e.g., `9999`).  
Watch transcriptions in the service logs:

```bash
journalctl -u asterisk-openai.service -n 200 -f
```

Example excerpts:
```text
O-0005 | 2025-06-28T04:15:01.924Z [INFO] [OpenAI] Assistant transcription: Hello! I'm Sofia...
O-0010 | 2025-06-28T04:15:08.045Z [INFO] [OpenAI] User command transcription: What is your name?
```

Stop the service:
```bash
sudo systemctl stop asterisk-openai.service
```

---

## Troubleshooting
- **`OPENAI_API_KEY is missing`** — verify the key in `config.conf`.
- **`ARI connection error`** — check Asterisk and port 8088:
  ```bash
  sudo systemctl status asterisk
  sudo asterisk -rx "ari show status"
  ```
- **No transcriptions** — set `LOG_LEVEL=debug` in `config.conf`.
- **Debugging**:
  ```bash
  tail -f /var/log/asterisk/messages
  cd /opt/asterisk_to_openai_rt_community
  node --inspect index.js
  ```
- **No audio** — ensure `external_media_address` & `external_signaling_address` in `pjsip.conf` match your server’s public IP. Verify RTP ports (12000+) are open in firewall. Check that `asterisk.js` uses the correct `external_host`.

- **Handoff didn’t trigger** — say a phrase that makes the **assistant** reply with one of your `REDIRECTION_PHRASES`. Check logs for:
  ```
  Assistant redirect phrase matched (...) ; requesting queue handoff
  ```
  If missing: verify spelling/case in `config.conf` and that `REDIRECTION_QUEUE` points to an existing FreePBX Queue.

- **Call didn’t terminate** — end with a phrase present in `AGENT_TERMINATE_PHRASES` and check for:
  ```
  Assistant termination phrase matched (...)
  ```

---

## Contributing
- Report issues with logs and steps to reproduce.
- Submit pull requests via GitHub.
- License: MIT (see `LICENSE`).
