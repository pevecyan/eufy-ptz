const { EufySecurity, PanTiltDirection } = require("eufy-security-client");

// ── Credentials ──────────────────────────────────────────────
const EUFY_EMAIL = "pevec@outlook.com";
const EUFY_PASSWORD = "Tinsko1994!";

// ── Configuration ────────────────────────────────────────────
const COUNTRY = "SI";
const LANGUAGE = "en";
const PERSISTENT_DIR = "./data";

async function main() {
    const config = {
        username: EUFY_EMAIL,
        password: EUFY_PASSWORD,
        country: COUNTRY,
        language: LANGUAGE,
        persistentDir: PERSISTENT_DIR,
        p2pConnectionSetup: 0,
        pollingIntervalMinutes: 10,
        eventDurationSeconds: 10,
    };

    const eufy = await EufySecurity.initialize(config);

    // ── Event listeners ──────────────────────────────────────
    eufy.on("station added", (station) => {
        console.log(`Station added: ${station.getName()} (${station.getSerial()})`);
    });

    eufy.on("device added", (device) => {
        console.log(`Device added: ${device.getName()} (${device.getSerial()}) - Type: ${device.getDeviceType()}`);
    });

    eufy.on("push connect", () => console.log("Push connected"));
    eufy.on("push close", () => console.log("Push closed"));

    eufy.on("connect", () => {
        console.log("Connected to Eufy cloud");
    });

    // Handle 2FA if required
    eufy.on("tfa request", () => {
        console.log("2FA requested - check your email/SMS and call: eufy.setVerifyCode('CODE')");
    });

    eufy.on("captcha request", (id, captcha) => {
        console.log("Captcha requested - solve and call: eufy.setCaptcha(id, answer)");
    });

    // Connect
    console.log("Connecting to Eufy cloud...");
    await eufy.connect();

    // Wait for device discovery to complete, then list everything
    setTimeout(() => {
        listDevicesAndStations(eufy);
    }, 5000);

    // Keep process alive
    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        eufy.close();
        process.exit(0);
    });
}

async function listDevicesAndStations(eufy) {
    const stations = await eufy.getStations();
    const devices = await eufy.getDevices();

    console.log("\n=== Stations ===");
    for (const station of stations) {
        console.log(`  ${station.getName()} - ${station.getSerial()} (Type: ${station.getDeviceType()})`);
    }

    console.log("\n=== Devices ===");
    for (const device of devices) {
        console.log(`  ${device.getName()} - ${device.getSerial()} (Type: ${device.getDeviceType()})`);
    }
    console.log("");
}

// ── PTZ Control Functions ────────────────────────────────────

async function ptz(eufy, direction) {
    const stations = eufy.getStations();
    const devices = eufy.getDevices();

    let targetDevice = null;
    let targetStation = null;

    for (const device of devices) {
        const type = device.getDeviceType();
        // C220 device types: 10008, 10010, 10011 + other PT models
        if ([31, 35, 104, 105, 10008, 10009, 10010, 10011].includes(type)) {
            targetDevice = device;
            targetStation = stations.find(s => s.getSerial() === device.getStationSerial());
            break;
        }
    }

    if (!targetDevice || !targetStation) {
        console.log("No pan-tilt capable device found!");
        return;
    }

    console.log(`Sending PTZ command: ${direction} to ${targetDevice.getName()}`);
    await targetStation.panAndTilt(targetDevice, direction);
}

const ptzUp = (eufy) => ptz(eufy, PanTiltDirection.UP);
const ptzDown = (eufy) => ptz(eufy, PanTiltDirection.DOWN);
const ptzLeft = (eufy) => ptz(eufy, PanTiltDirection.LEFT);
const ptzRight = (eufy) => ptz(eufy, PanTiltDirection.RIGHT);
const ptzRotate360 = (eufy) => ptz(eufy, PanTiltDirection.ROTATE360);

module.exports = { ptz, ptzUp, ptzDown, ptzLeft, ptzRight, ptzRotate360 };

main().catch(console.error);
