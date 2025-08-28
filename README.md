# FreePBX to OpenAI Realtime Community Edition
forked from infinitocloud/asterisk_to_openai_rt_community

Welcome! This Node.js application integrates FreePBX 17 (Debian) with the OpenAI Realtime API to provide a voice-based virtual assistant for SIP calls. It processes audio in real-time and displays user and assistant transcriptions in the console. 

---

## Features
- Real-time audio processing with Asterisk and OpenAI.
- Console transcriptions for user and assistant speech.
- Clean resource management (channels, bridges, WebSocket, RTP).
- Configurable via `config.conf` (e.g., API key, prompt).

---

## Requirements
| Category      | Details                                      |
|---------------|---------------------------------------------|
| OS            | Debian 13                            |
| Software      | Free PBX 17
| Network       | - Ports: 8088 (ARI), 12000+ (RTP)<br>- Access to `wss://api.openai.com/v1/realtime` |
| Credentials   | - OpenAI API key (`OPENAI_API_KEY`) - prepare the key before the installation - it is neccesary to finish the installation script

---

## Installation
1. Log in as root (or use sudo) 
cd /root
2. Download the script from the repo
curl -fsSL -o autoinstall_asterisk_to_openai.sh https://raw.githubusercontent.com/maladrill/asterisk_to_openai_rt_community/main/autoinstall_asterisk_to_openai.sh
3. Make it executable and run it (but have OpnAI key prepared as it will be used during the installation)
chmod +x autoinstall_asterisk_to_openai.sh
./autoinstall_asterisk_to_openai.sh

Optional (verbose mode):
DEBUG=1 ./autoinstall_asterisk_to_openai.sh
4.Go to /opt/asterisk_to_openai_rt_community/config.conf and change what you need: 
SYSTEM_PROMPT - it is the instruction for the assistant
OPENAI_VOICE - voices you can use are: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer
TRANSCRIPTION_LANGUAGE - supported langages:  'af'=>'Afrikaans','ar'=>'Arabic','hy'=>'Armenian','az'=>'Azerbaijani','be'=>'Belarusian','bs'=>'Bosnian','bg'=>'Bulgarian','ca'=>'Catalan',
  'zh'=>'Chinese','hr'=>'Croatian','cs'=>'Czech','da'=>'Danish','nl'=>'Dutch','en'=>'English','et'=>'Estonian','fi'=>'Finnish','fr'=>'French',
  'gl'=>'Galician','de'=>'German','el'=>'Greek','he'=>'Hebrew','hi'=>'Hindi','hu'=>'Hungarian','is'=>'Icelandic','id'=>'Indonesian','it'=>'Italian',
  'ja'=>'Japanese','kn'=>'Kannada','kk'=>'Kazakh','ko'=>'Korean','lv'=>'Latvian','lt'=>'Lithuanian','mk'=>'Macedonian','ms'=>'Malay','mr'=>'Marathi',
  'mi'=>'Maori','ne'=>'Nepali','no'=>'Norwegian','fa'=>'Persian','pl'=>'Polish','pt'=>'Portuguese','ro'=>'Romanian','ru'=>'Russian','sr'=>'Serbian',
  'sk'=>'Slovak','sl'=>'Slovenian','es'=>'Spanish','sw'=>'Swahili','sv'=>'Swedish','tl'=>'Tagalog','ta'=>'Tamil','th'=>'Thai','tr'=>'Turkish',
  'uk'=>'Ukrainian','ur'=>'Urdu','vi'=>'Vietnamese','cy'=>'Welsh',



--------------------------------------------------------------------------------
FreePBX GUI manual: Route calls to the custom dialplan (9999)
--------------------------------------------------------------------------------

Option A) Quick test from any internal phone
  - Dial: 9999     (context: from-internal)

Option B) Create a Custom Destination and a Misc Application
  1) Admin → Custom Destinations → Add
     - Custom Destination: from-internal-custom,9999,1
     - Description: OpenAI Realtime (9999)
     - Return: No
     - Submit, then Apply Config
       
![Screenshot](https://github.com/maladrill/asterisk_to_openai_rt_community/blob/main/custom_destinations.png)

  2) Applications → Misc Applications → Add
     - Description: OpenAI Realtime
     - Feature Code: *9999   (or 9999 if you prefer)
     - Destination: Custom Destinations → OpenAI Realtime (9999)
     - Submit, then Apply Config

Option C) Inbound Route → Destination
  - To point an external DID to the app:
    Connectivity → Inbound Routes → (pick your DID)
    - Set Destination: Custom Destinations → OpenAI Realtime (9999)
    - Submit, then Apply Config

Notes:
  - We use only *_custom.conf files (http_custom.conf, ari_general_custom.conf, ari_additional_custom.conf).
  - We do NOT edit ari.conf or http.conf (they are FreePBX-generated).
  - The app reads config from /opt/asterisk_to_openai_rt_community/config.conf.
--------------------------------------------------------------------------------

## Usage
1. Make a SIP call to the configured extension (e.g., `9999`).
2. Interact with the assistant (e.g., say "Hi", "What is your name?").
3. Check console for transcriptions:
   journalctl -u asterisk-openai.service -n 200 -f
   ```
   O-0005 | 2025-06-28T04:15:01.924Z [INFO] [OpenAI] Assistant transcription: Hello! I'm Sofia...
   O-0010 | 2025-06-28T04:15:08.045Z [INFO] [OpenAI] User command transcription: What is your name?
   ```
4. End the call or press `Ctrl+C` to stop.

## Troubleshooting
- Error: `OPENAI_API_KEY is missing`: Verify `OPENAI_API_KEY` in `config.conf`.
- Error: `ARI connection error`: Check Asterisk (`sudo systemctl status asterisk`, port 8088). Run: `sudo asterisk -rx "ari show status"`
- No transcriptions: Set `LOG_LEVEL=debug` in `config.conf`.
- Debug commands:
  - Asterisk logs: `tail -f /var/log/asterisk/messages`
  - Node.js debug: `cd /opt/asterisk_to_openai_rt_community` and then: `node --inspect index.js`
- No audio: Ensure `external_media_address` and `external_signaling_address` in `pjsip.conf` match your EC2 public IP. Verify RTP ports (12000+) are open in EC2 security group and local firewall. Update `asterisk.js` `external_host` to use the server’s IP.

---

## Contributing
- Report issues with logs and steps to reproduce.
- Submit pull requests via GitHub.
- License: MIT (see `LICENSE`).
