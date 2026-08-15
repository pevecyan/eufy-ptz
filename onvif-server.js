const http = require("http");
const dgram = require("dgram");
const os = require("os");
const { parseStringPromise } = require("xml2js");
const { EufySecurity, PanTiltDirection } = require("eufy-security-client");
const config = require("./config.json");

// ── State ────────────────────────────────────────────────────
let eufyClient = null;
let targetStation = null;
let targetDevice = null;
let currentPanTilt = { x: 0, y: 0 };
let currentZoom = 0;
let moveStatus = "IDLE";

const SERVICE_TAG = `urn:uuid:${generateUUID()}`;
const ONVIF_PORT = config.onvif.port;

// ── Eufy Connection ──────────────────────────────────────────

async function connectEufy() {
    const cfg = {
        username: config.eufy.email,
        password: config.eufy.password,
        country: config.eufy.country,
        language: config.eufy.language,
        persistentDir: "./data",
        p2pConnectionSetup: 0,
        pollingIntervalMinutes: 10,
        eventDurationSeconds: 10,
    };

    eufyClient = await EufySecurity.initialize(cfg);

    eufyClient.on("station added", (station) => {
        console.log(`[eufy] Station: ${station.getName()} (${station.getSerial()})`);
        if (station.getSerial() === config.eufy.stationSerial) {
            targetStation = station;
        }
    });

    eufyClient.on("device added", (device) => {
        console.log(`[eufy] Device: ${device.getName()} (${device.getSerial()}) - Type: ${device.getDeviceType()}`);
        if (device.getStationSerial() === config.eufy.stationSerial) {
            targetDevice = device;
        }
    });

    eufyClient.on("tfa request", () => {
        console.log("[eufy] 2FA requested - check your email/SMS");
    });

    eufyClient.on("connect", () => console.log("[eufy] Connected to cloud"));
    eufyClient.on("push connect", () => console.log("[eufy] Push connected"));

    console.log("[eufy] Connecting...");
    await eufyClient.connect();

    // Wait for device discovery
    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (!targetStation || !targetDevice) {
        console.error(`[eufy] Station ${config.eufy.stationSerial} not found!`);
        process.exit(1);
    }

    console.log(`[eufy] Target device: ${targetDevice.getName()}`);
}

// ── PTZ Command Proxy ────────────────────────────────────────

async function sendPTZ(direction) {
    if (!targetStation || !targetDevice) {
        console.error("[ptz] No device connected");
        return;
    }
    console.log(`[ptz] Sending direction: ${PanTiltDirection[direction]} (${direction})`);
    moveStatus = "MOVING";

    // Bypass library's hasCommand check - C220 (type 10008) is missing
    // from the DeviceCommands map but supports PTZ via P2P protocol.
    // Send the indoor rotate command directly via P2P session.
    const command = direction === PanTiltDirection.ROTATE360 ? -1 : 1;
    targetStation.p2pSession.sendCommandWithStringPayload({
        commandType: 1700, // CMD_DOORBELL_SET_PAYLOAD
        value: JSON.stringify({
            commandType: 6030, // CMD_INDOOR_ROTATE
            data: {
                cmd_type: command,
                rotate_type: direction,
            },
        }),
        channel: targetDevice.getChannel(),
    }, {
        command: {
            name: "device_pan_and_tilt",
            value: direction,
        },
    });
}

async function handleContinuousMove(panSpeed, tiltSpeed) {
    // Map ONVIF velocity to Eufy direction
    // ONVIF: x positive = right, x negative = left
    //        y positive = up, y negative = down
    const absX = Math.abs(panSpeed);
    const absY = Math.abs(tiltSpeed);

    if (absX < 0.01 && absY < 0.01) {
        moveStatus = "IDLE";
        return;
    }

    // Pick dominant axis
    if (absX > absY) {
        await sendPTZ(panSpeed > 0 ? PanTiltDirection.RIGHT : PanTiltDirection.LEFT);
    } else {
        await sendPTZ(tiltSpeed > 0 ? PanTiltDirection.UP : PanTiltDirection.DOWN);
    }

    // Update virtual position
    currentPanTilt.x = clamp(currentPanTilt.x + panSpeed * 0.1, -1, 1);
    currentPanTilt.y = clamp(currentPanTilt.y + tiltSpeed * 0.1, -1, 1);
}

async function handleRelativeMove(panDelta, tiltDelta) {
    const absX = Math.abs(panDelta);
    const absY = Math.abs(tiltDelta);

    if (absX < 0.01 && absY < 0.01) return;

    if (absX > absY) {
        await sendPTZ(panDelta > 0 ? PanTiltDirection.RIGHT : PanTiltDirection.LEFT);
    } else {
        await sendPTZ(tiltDelta > 0 ? PanTiltDirection.UP : PanTiltDirection.DOWN);
    }

    currentPanTilt.x = clamp(currentPanTilt.x + panDelta, -1, 1);
    currentPanTilt.y = clamp(currentPanTilt.y + tiltDelta, -1, 1);
    moveStatus = "IDLE";
}

async function handleAbsoluteMove(panPos, tiltPos) {
    const dx = panPos - currentPanTilt.x;
    const dy = tiltPos - currentPanTilt.y;
    await handleRelativeMove(dx, dy);
}

function handleStop() {
    moveStatus = "IDLE";
    console.log("[ptz] Stop");
}

// ── SOAP Helpers ─────────────────────────────────────────────

function soapEnvelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
    xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

function soapFault(code, reason) {
    return soapEnvelope(`
    <s:Fault>
      <s:Code><s:Value>s:${code}</s:Value></s:Code>
      <s:Reason><s:Text xml:lang="en">${reason}</s:Text></s:Reason>
    </s:Fault>`);
}

async function parseSOAP(xml) {
    const result = await parseStringPromise(xml, {
        explicitArray: false,
        ignoreAttrs: false,
        tagNameProcessors: [(name) => name.replace(/^.*:/, "")],
    });
    const envelope = result.Envelope || result["s:Envelope"] || result["SOAP-ENV:Envelope"];
    const body = envelope?.Body || envelope?.["s:Body"] || envelope?.["SOAP-ENV:Body"];
    return body;
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// ── ONVIF Service Handlers ───────────────────────────────────

const localIP = config.onvif.advertiseIP || getLocalIP();

function handleDeviceService(action, body) {
    switch (action) {
        case "GetDeviceInformation":
            return soapEnvelope(`
    <tds:GetDeviceInformationResponse>
      <tds:Manufacturer>Eufy</tds:Manufacturer>
      <tds:Model>C220</tds:Model>
      <tds:FirmwareVersion>1.0.0</tds:FirmwareVersion>
      <tds:SerialNumber>${config.eufy.stationSerial}</tds:SerialNumber>
      <tds:HardwareId>C220-PTZ</tds:HardwareId>
    </tds:GetDeviceInformationResponse>`);

        case "GetCapabilities":
            return soapEnvelope(`
    <tds:GetCapabilitiesResponse>
      <tds:Capabilities>
        <tt:Device>
          <tt:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/device_service</tt:XAddr>
        </tt:Device>
        <tt:Media>
          <tt:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/media_service</tt:XAddr>
        </tt:Media>
        <tt:PTZ>
          <tt:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/ptz_service</tt:XAddr>
        </tt:PTZ>
      </tds:Capabilities>
    </tds:GetCapabilitiesResponse>`);

        case "GetServices":
            return soapEnvelope(`
    <tds:GetServicesResponse>
      <tds:Service>
        <tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>
        <tds:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/device_service</tds:XAddr>
        <tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version>
      </tds:Service>
      <tds:Service>
        <tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>
        <tds:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/media_service</tds:XAddr>
        <tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version>
      </tds:Service>
      <tds:Service>
        <tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace>
        <tds:XAddr>http://${localIP}:${ONVIF_PORT}/onvif/ptz_service</tds:XAddr>
        <tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version>
      </tds:Service>
    </tds:GetServicesResponse>`);

        case "GetScopes":
            return soapEnvelope(`
    <tds:GetScopesResponse>
      <tds:Scopes>
        <tt:ScopeDef>Fixed</tt:ScopeDef>
        <tt:ScopeItem>onvif://www.onvif.org/type/ptz</tt:ScopeItem>
      </tds:Scopes>
      <tds:Scopes>
        <tt:ScopeDef>Fixed</tt:ScopeDef>
        <tt:ScopeItem>onvif://www.onvif.org/Profile/Streaming</tt:ScopeItem>
      </tds:Scopes>
      <tds:Scopes>
        <tt:ScopeDef>Fixed</tt:ScopeDef>
        <tt:ScopeItem>onvif://www.onvif.org/hardware/C220</tt:ScopeItem>
      </tds:Scopes>
      <tds:Scopes>
        <tt:ScopeDef>Fixed</tt:ScopeDef>
        <tt:ScopeItem>onvif://www.onvif.org/name/EufyC220</tt:ScopeItem>
      </tds:Scopes>
    </tds:GetScopesResponse>`);

        case "GetSystemDateAndTime":
            const now = new Date();
            return soapEnvelope(`
    <tds:GetSystemDateAndTimeResponse>
      <tds:SystemDateAndTime>
        <tt:DateTimeType>NTP</tt:DateTimeType>
        <tt:DaylightSavings>true</tt:DaylightSavings>
        <tt:UTCDateTime>
          <tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time>
          <tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date>
        </tt:UTCDateTime>
      </tds:SystemDateAndTime>
    </tds:GetSystemDateAndTimeResponse>`);

        default:
            return soapFault("Receiver", `Unknown device action: ${action}`);
    }
}

function handleMediaService(action, body) {
    switch (action) {
        case "GetProfiles":
        case "GetProfile":
            return soapEnvelope(`
    <trt:GetProfilesResponse>
      <trt:Profiles token="profile1" fixed="true">
        <tt:Name>MainProfile</tt:Name>
        <tt:VideoSourceConfiguration token="video_src_cfg1">
          <tt:Name>VideoSourceConfig</tt:Name>
          <tt:UseCount>1</tt:UseCount>
          <tt:SourceToken>video_src1</tt:SourceToken>
          <tt:Bounds x="0" y="0" width="1920" height="1080"/>
        </tt:VideoSourceConfiguration>
        <tt:VideoEncoderConfiguration token="video_enc_cfg1">
          <tt:Name>VideoEncoderConfig</tt:Name>
          <tt:UseCount>1</tt:UseCount>
          <tt:Encoding>H264</tt:Encoding>
          <tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution>
          <tt:Quality>4</tt:Quality>
          <tt:RateControl>
            <tt:FrameRateLimit>15</tt:FrameRateLimit>
            <tt:EncodingInterval>1</tt:EncodingInterval>
            <tt:BitrateLimit>2048</tt:BitrateLimit>
          </tt:RateControl>
          <tt:H264>
            <tt:GovLength>30</tt:GovLength>
            <tt:H264Profile>Main</tt:H264Profile>
          </tt:H264>
          <tt:SessionTimeout>PT60S</tt:SessionTimeout>
        </tt:VideoEncoderConfiguration>
        <tt:PTZConfiguration token="ptz_config1">
          <tt:Name>PTZConfig</tt:Name>
          <tt:UseCount>1</tt:UseCount>
          <tt:NodeToken>ptz_node1</tt:NodeToken>
          <tt:DefaultAbsolutePantTiltPositionSpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:DefaultAbsolutePantTiltPositionSpace>
          <tt:DefaultAbsoluteZoomPositionSpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace</tt:DefaultAbsoluteZoomPositionSpace>
          <tt:DefaultRelativePanTiltTranslationSpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:DefaultRelativePanTiltTranslationSpace>
          <tt:DefaultRelativeZoomTranslationSpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace</tt:DefaultRelativeZoomTranslationSpace>
          <tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>
          <tt:DefaultContinuousZoomVelocitySpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:DefaultContinuousZoomVelocitySpace>
          <tt:DefaultPTZTimeout>PT5S</tt:DefaultPTZTimeout>
        </tt:PTZConfiguration>
      </trt:Profiles>
    </trt:GetProfilesResponse>`);

        case "GetVideoSources":
            return soapEnvelope(`
    <trt:GetVideoSourcesResponse>
      <trt:VideoSources token="video_src1">
        <tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution>
      </trt:VideoSources>
    </trt:GetVideoSourcesResponse>`);

        case "GetStreamUri":
            return soapEnvelope(`
    <trt:GetStreamUriResponse>
      <trt:MediaUri>
        <tt:Uri>rtsp://${localIP}:554/stream</tt:Uri>
        <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
        <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
        <tt:Timeout>PT60S</tt:Timeout>
      </trt:MediaUri>
    </trt:GetStreamUriResponse>`);

        case "GetVideoSourceConfigurations":
            return soapEnvelope(`
    <trt:GetVideoSourceConfigurationsResponse>
      <trt:Configurations token="video_src_cfg1">
        <tt:Name>VideoSourceConfig</tt:Name>
        <tt:UseCount>1</tt:UseCount>
        <tt:SourceToken>video_src1</tt:SourceToken>
      </trt:Configurations>
    </trt:GetVideoSourceConfigurationsResponse>`);

        default:
            return soapFault("Receiver", `Unknown media action: ${action}`);
    }
}

async function handlePTZService(action, body) {
    switch (action) {
        case "GetNodes":
        case "GetNode":
            return soapEnvelope(`
    <tptz:GetNodesResponse>
      <tptz:PTZNode token="ptz_node1" FixedHomePosition="false">
        <tt:Name>EufyC220-PTZ</tt:Name>
        <tt:SupportedPTZSpaces>
          <tt:ContinuousPanTiltVelocitySpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
            <tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>
          </tt:ContinuousPanTiltVelocitySpace>
          <tt:ContinuousZoomVelocitySpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
          </tt:ContinuousZoomVelocitySpace>
          <tt:RelativePanTiltTranslationSpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
            <tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>
          </tt:RelativePanTiltTranslationSpace>
          <tt:AbsolutePanTiltPositionSpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
            <tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>
          </tt:AbsolutePanTiltPositionSpace>
        </tt:SupportedPTZSpaces>
        <tt:MaximumNumberOfPresets>8</tt:MaximumNumberOfPresets>
        <tt:HomeSupported>false</tt:HomeSupported>
      </tptz:PTZNode>
    </tptz:GetNodesResponse>`);

        case "GetConfigurations":
        case "GetConfiguration":
            return soapEnvelope(`
    <tptz:GetConfigurationsResponse>
      <tptz:PTZConfiguration token="ptz_config1">
        <tt:Name>PTZConfig</tt:Name>
        <tt:UseCount>1</tt:UseCount>
        <tt:NodeToken>ptz_node1</tt:NodeToken>
        <tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>
        <tt:DefaultContinuousZoomVelocitySpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:DefaultContinuousZoomVelocitySpace>
        <tt:PanTiltLimits>
          <tt:Range>
            <tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
            <tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>
          </tt:Range>
        </tt:PanTiltLimits>
      </tptz:PTZConfiguration>
    </tptz:GetConfigurationsResponse>`);

        case "GetConfigurationOptions":
            return soapEnvelope(`
    <tptz:GetConfigurationOptionsResponse>
      <tptz:PTZConfigurationOptions>
        <tt:Spaces>
          <tt:ContinuousPanTiltVelocitySpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
            <tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>
          </tt:ContinuousPanTiltVelocitySpace>
          <tt:ContinuousZoomVelocitySpace>
            <tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI>
            <tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>
          </tt:ContinuousZoomVelocitySpace>
        </tt:Spaces>
      </tptz:PTZConfigurationOptions>
    </tptz:GetConfigurationOptionsResponse>`);

        case "GetServiceCapabilities":
            return soapEnvelope(`
    <tptz:GetServiceCapabilitiesResponse>
      <tptz:Capabilities EFlip="false" Reverse="false" GetCompatibleConfigurations="false"/>
    </tptz:GetServiceCapabilitiesResponse>`);

        case "ContinuousMove": {
            let panSpeed = 0, tiltSpeed = 0;
            try {
                const velocity = findNode(body, "Velocity");
                const pt = findNode(velocity, "PanTilt");
                panSpeed = parseFloat(pt?.["$"]?.x || pt?.["$"]?.["x"] || 0);
                tiltSpeed = parseFloat(pt?.["$"]?.y || pt?.["$"]?.["y"] || 0);
            } catch (e) {}
            console.log(`[onvif] ContinuousMove pan=${panSpeed} tilt=${tiltSpeed}`);
            await handleContinuousMove(panSpeed, tiltSpeed);
            return soapEnvelope(`<tptz:ContinuousMoveResponse/>`);
        }

        case "RelativeMove": {
            let panDelta = 0, tiltDelta = 0;
            try {
                const translation = findNode(body, "Translation");
                const pt = findNode(translation, "PanTilt");
                panDelta = parseFloat(pt?.["$"]?.x || 0);
                tiltDelta = parseFloat(pt?.["$"]?.y || 0);
            } catch (e) {}
            console.log(`[onvif] RelativeMove pan=${panDelta} tilt=${tiltDelta}`);
            await handleRelativeMove(panDelta, tiltDelta);
            return soapEnvelope(`<tptz:RelativeMoveResponse/>`);
        }

        case "AbsoluteMove": {
            let panPos = 0, tiltPos = 0;
            try {
                const position = findNode(body, "Position");
                const pt = findNode(position, "PanTilt");
                panPos = parseFloat(pt?.["$"]?.x || 0);
                tiltPos = parseFloat(pt?.["$"]?.y || 0);
            } catch (e) {}
            console.log(`[onvif] AbsoluteMove pan=${panPos} tilt=${tiltPos}`);
            await handleAbsoluteMove(panPos, tiltPos);
            return soapEnvelope(`<tptz:AbsoluteMoveResponse/>`);
        }

        case "Stop":
            handleStop();
            return soapEnvelope(`<tptz:StopResponse/>`);

        case "GetStatus":
            return soapEnvelope(`
    <tptz:GetStatusResponse>
      <tptz:PTZStatus>
        <tt:Position>
          <tt:PanTilt x="${currentPanTilt.x}" y="${currentPanTilt.y}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/>
          <tt:Zoom x="${currentZoom}" space="http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace"/>
        </tt:Position>
        <tt:MoveStatus>
          <tt:PanTilt>${moveStatus}</tt:PanTilt>
          <tt:Zoom>IDLE</tt:Zoom>
        </tt:MoveStatus>
        <tt:UtcTime>${new Date().toISOString()}</tt:UtcTime>
      </tptz:PTZStatus>
    </tptz:GetStatusResponse>`);

        case "GetPresets":
            return soapEnvelope(`<tptz:GetPresetsResponse/>`);

        case "GotoPreset":
            return soapEnvelope(`<tptz:GotoPresetResponse/>`);

        case "GotoHomePosition":
            return soapEnvelope(`<tptz:GotoHomePositionResponse/>`);

        default:
            return soapFault("Receiver", `Unknown PTZ action: ${action}`);
    }
}

// Recursively find a node by local name in parsed XML
function findNode(obj, name) {
    if (!obj || typeof obj !== "object") return null;
    for (const key of Object.keys(obj)) {
        const localName = key.replace(/^.*:/, "");
        if (localName === name) return obj[key];
        const found = findNode(obj[key], name);
        if (found) return found;
    }
    return null;
}

// ── HTTP Server ──────────────────────────────────────────────

function extractAction(soapAction, xmlBody) {
    // Try SOAPAction header first
    if (soapAction) {
        const match = soapAction.replace(/"/g, "").match(/\/(\w+)$/);
        if (match) return match[1];
    }
    // Fall back to first child element of Body
    if (xmlBody && typeof xmlBody === "object") {
        const keys = Object.keys(xmlBody).filter((k) => k !== "$");
        if (keys.length > 0) {
            return keys[0].replace(/^.*:/, "");
        }
    }
    return null;
}

const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Eufy ONVIF PTZ Server");
        return;
    }

    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    let response;
    try {
        const body = await parseSOAP(rawBody);
        const action = extractAction(req.headers["soapaction"], body);

        if (!action) {
            response = soapFault("Sender", "Could not determine SOAP action");
        } else if (req.url.includes("device_service") || req.url === "/onvif/device_service") {
            response = handleDeviceService(action, body);
        } else if (req.url.includes("media_service") || req.url === "/onvif/media_service") {
            response = handleMediaService(action, body);
        } else if (req.url.includes("ptz_service") || req.url === "/onvif/ptz_service") {
            response = await handlePTZService(action, body);
        } else {
            // Try to route by action name
            if (["GetDeviceInformation", "GetCapabilities", "GetServices", "GetScopes", "GetSystemDateAndTime"].includes(action)) {
                response = handleDeviceService(action, body);
            } else if (["GetProfiles", "GetProfile", "GetStreamUri", "GetVideoSources", "GetVideoSourceConfigurations"].includes(action)) {
                response = handleMediaService(action, body);
            } else {
                response = await handlePTZService(action, body);
            }
        }
    } catch (err) {
        console.error("[onvif] Error:", err.message);
        response = soapFault("Receiver", err.message);
    }

    res.writeHead(200, {
        "Content-Type": "application/soap+xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(response),
    });
    res.end(response);
});

// ── WS-Discovery ─────────────────────────────────────────────

function startDiscovery() {
    const MULTICAST_ADDR = "239.255.255.250";
    const MULTICAST_PORT = 3702;

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    socket.on("message", (msg, rinfo) => {
        const msgStr = msg.toString();
        if (!msgStr.includes("Probe") && !msgStr.includes("probe")) return;

        console.log(`[discovery] Probe from ${rinfo.address}:${rinfo.port}`);

        const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
    xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:MessageID>urn:uuid:${generateUUID()}</a:MessageID>
    <a:RelatesTo>urn:uuid:${generateUUID()}</a:RelatesTo>
    <a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action>
  </s:Header>
  <s:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <a:EndpointReference><a:Address>${SERVICE_TAG}</a:Address></a:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>onvif://www.onvif.org/type/ptz onvif://www.onvif.org/hardware/C220 onvif://www.onvif.org/name/EufyC220</d:Scopes>
        <d:XAddrs>http://${localIP}:${ONVIF_PORT}/onvif/device_service</d:XAddrs>
        <d:MetadataVersion>1</d:MetadataVersion>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </s:Body>
</s:Envelope>`;

        const buf = Buffer.from(responseXml);
        socket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    });

    socket.bind(MULTICAST_PORT, () => {
        socket.addMembership(MULTICAST_ADDR);
        console.log(`[discovery] Listening on ${MULTICAST_ADDR}:${MULTICAST_PORT}`);
    });

    socket.on("error", (err) => {
        console.warn(`[discovery] Error: ${err.message} (discovery may not work)`);
    });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
    await connectEufy();

    server.listen(ONVIF_PORT, config.onvif.hostname, () => {
        console.log(`\n[onvif] ONVIF PTZ server running at http://${localIP}:${ONVIF_PORT}`);
        console.log(`[onvif] Device service: http://${localIP}:${ONVIF_PORT}/onvif/device_service`);
        console.log(`[onvif] Media service:  http://${localIP}:${ONVIF_PORT}/onvif/media_service`);
        console.log(`[onvif] PTZ service:    http://${localIP}:${ONVIF_PORT}/onvif/ptz_service`);
    });

    startDiscovery();

    process.on("SIGINT", () => {
        console.log("\nShutting down...");
        eufyClient?.close();
        server.close();
        process.exit(0);
    });
}

main().catch(console.error);
