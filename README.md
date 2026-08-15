# eufy-ptz

ONVIF PTZ proxy server for Eufy pan-tilt cameras. Exposes an ONVIF-compliant PTZ service that translates standard ONVIF commands into Eufy P2P protocol commands, allowing integration with NVR software like [Frigate](https://frigate.video/).

## Supported cameras

- Indoor Cam C220 (T8W11C)
- Indoor Cam C210 (T8419)
- Indoor Pan & Tilt cameras (type 31, 35, 104, 105)

## Setup

### 1. Find your station serial

Run the discovery script to find your camera's station serial:

```bash
npm install
node main.js
```

Update your Eufy credentials in `main.js` first. The output will show your station serial (e.g. `T8W11PXXXXXXXXXX`).

### 2. Configure

Copy the example config and fill in your details:

```bash
cp config.example.json config.json
```

| Field | Description |
|---|---|
| `eufy.email` | Your Eufy account email |
| `eufy.password` | Your Eufy account password |
| `eufy.country` | Your country code (e.g. `US`, `SI`, `DE`) |
| `eufy.stationSerial` | Station serial from step 1 |
| `onvif.port` | ONVIF server port (default: `8080`) |
| `onvif.hostname` | Bind address (default: `0.0.0.0`) |
| `onvif.advertiseIP` | IP address advertised in ONVIF responses. Set this to the IP that your ONVIF client (e.g. Frigate) can reach. |

### 3. Run

```bash
npm start
```

## Docker

### Build and run

```bash
docker build -t eufy-ptz .
docker run -d \
  --name eufy-ptz \
  --network host \
  -v ./config.json:/app/config.json:ro \
  -v ./data:/app/data \
  eufy-ptz
```

> `--network host` is recommended for WS-Discovery (UDP multicast) and P2P connectivity.

### Docker Compose

```yaml
services:
  eufy-ptz:
    image: ghcr.io/pevecyan/eufy-ptz:latest
    container_name: eufy-ptz
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config.json:/app/config.json:ro
      - ./data:/app/data
```

```bash
docker compose up -d
```

## Frigate integration

Add the ONVIF configuration to your camera in Frigate's config:

```yaml
cameras:
  your_camera:
    ffmpeg:
      inputs:
        - path: rtsp://your-camera-stream-url
          roles:
            - detect
            - record
    onvif:
      host: 192.168.1.100  # IP where eufy-ptz is running
      port: 8080
```

If Frigate runs in Docker, set `onvif.advertiseIP` in `config.json` to the IP that Frigate can reach (e.g. the Docker gateway IP `172.19.0.1` or the host IP).

## Supported ONVIF operations

### PTZ
- `ContinuousMove` - Pan/tilt in a direction
- `RelativeMove` - Relative pan/tilt movement
- `AbsoluteMove` - Absolute position movement
- `Stop` - Stop movement
- `GetStatus` - Current position and move status
- `GetNodes` / `GetConfigurations` / `GetConfigurationOptions`
- `GetPresets` / `GotoPreset` / `GotoHomePosition`

### Device & Media
- `GetDeviceInformation` / `GetCapabilities` / `GetServices`
- `GetProfiles` / `GetStreamUri` / `GetVideoSources`
- `GetSystemDateAndTime` / `GetScopes`
- WS-Discovery (auto-discovery on local network)

## Notes

- **PTZ only** - This server proxies PTZ commands. Video streaming must be configured separately.
- **Eufy legacy API** - Uses `eufy-security-client` which relies on Eufy's legacy APIs. These may be discontinued as Eufy migrates to their new platform.
- **2FA** - If your Eufy account has 2FA enabled, you will need to handle the verification code on first run. The session is persisted in the `data/` directory.

## License

MIT
