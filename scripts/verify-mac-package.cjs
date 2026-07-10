const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appRoot = path.join(root, "release", "mac-arm64", "Tether.app", "Contents");
const executable = path.join(appRoot, "MacOS", "Tether");
const packagedConnectionLoss = path.join(
  appRoot,
  "Resources",
  "app.asar",
  "src",
  "main",
  "connectionLoss.cjs"
);
const sourceIcon = path.join(root, "resources", "tether-icon.icns");
const packagedIcon = path.join(appRoot, "Resources", "icon.icns");

for (const requiredPath of [executable, sourceIcon, packagedIcon]) {
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`Packaged macOS app is missing ${path.relative(root, requiredPath)}`);
  }
}

const smoke = childProcess.spawnSync(
  executable,
  ["-e", 'require(process.argv[1]); process.stdout.write("main-import-ok\\n")', packagedConnectionLoss],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }
);

if (smoke.status !== 0 || !smoke.stdout.includes("main-import-ok")) {
  throw new Error(
    ["Packaged main-process import smoke test failed.", smoke.stdout, smoke.stderr]
      .filter(Boolean)
      .join("\n")
  );
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (sha256(sourceIcon) !== sha256(packagedIcon)) {
  throw new Error("Packaged macOS icon does not match resources/tether-icon.icns");
}

console.log("Verified packaged main-process imports and custom macOS icon.");
