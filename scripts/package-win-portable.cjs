const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const releaseRoot = path.join(root, "release");
const outputDir = path.join(releaseRoot, "Tether-win32-x64");
const appDir = path.join(outputDir, "resources", "app");
const appNodeModulesDir = path.join(appDir, "node_modules");

const runtimeEntryPackages = ["ssh2-sftp-client"];
const appIconIcoPath = path.join(releaseRoot, "tether-icon.ico");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  assertWindowsElectronRuntime();
  assertInside(outputDir, releaseRoot);

  run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"]);

  const electronExe = require("electron");
  const electronDist = path.dirname(electronExe);

  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.cp(electronDist, outputDir, { recursive: true });
  const executablePath = path.join(outputDir, "Tether.exe");
  await fs.rename(path.join(outputDir, "electron.exe"), executablePath);
  await ensureWindowsIcon();
  await setExecutableMetadata(executablePath);

  await fs.rm(path.join(outputDir, "resources", "default_app.asar"), { force: true });
  await fs.mkdir(appDir, { recursive: true });

  await writePortablePackageJson();
  await fs.cp(path.join(root, "dist"), path.join(appDir, "dist"), { recursive: true });
  await fs.cp(path.join(root, "src", "main"), path.join(appDir, "src", "main"), { recursive: true });
  await fs.cp(path.join(root, "src", "shared"), path.join(appDir, "src", "shared"), { recursive: true });
  await fs.cp(path.join(root, "samples"), path.join(appDir, "samples"), { recursive: true });
  await fs.cp(path.join(root, "resources"), path.join(appDir, "resources"), { recursive: true });

  await fs.mkdir(appNodeModulesDir, { recursive: true });
  const runtimePackages = collectRuntimePackageNames(runtimeEntryPackages);
  for (const packageName of runtimePackages) {
    await copyRuntimePackage(packageName);
  }
  await pruneRuntimeArtifacts();

  await fs.writeFile(
    path.join(outputDir, "README.txt"),
    [
      "Tether portable build",
      "",
      "Run Tether.exe to start the app.",
      "Keep the files and folders in this directory together; Tether.exe depends on the adjacent Electron runtime files.",
      "",
      "This package does not include local .env files, SSH keys, git history, or development server files."
    ].join("\r\n"),
    "utf8"
  );

  console.log(`Portable build written to ${outputDir}`);
  console.log(`Launch ${path.join(outputDir, "Tether.exe")}`);
}

function assertWindowsElectronRuntime() {
  const electronExe = require("electron");
  if (path.basename(electronExe).toLowerCase() !== "electron.exe") {
    throw new Error("This script needs a Windows Electron runtime and must be run on Windows.");
  }
}

function assertInside(target, parent) {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to package outside release directory: ${target}`);
  }
}

function run(command, args) {
  childProcess.execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
    stdio: "inherit"
  });
}

async function ensureWindowsIcon() {
  const headerSize = 6;
  const entrySize = 16 * iconSizes.length;
  const images = iconSizes.map(createIconDib);
  const icon = Buffer.alloc(headerSize + entrySize + images.reduce((sum, image) => sum + image.length, 0));

  icon.writeUInt16LE(0, 0);
  icon.writeUInt16LE(1, 2);
  icon.writeUInt16LE(images.length, 4);

  let offset = headerSize + entrySize;
  images.forEach((image, index) => {
    const size = iconSizes[index];
    const entryOffset = headerSize + index * 16;
    icon.writeUInt8(size === 256 ? 0 : size, entryOffset);
    icon.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    icon.writeUInt8(0, entryOffset + 2);
    icon.writeUInt8(0, entryOffset + 3);
    icon.writeUInt16LE(1, entryOffset + 4);
    icon.writeUInt16LE(32, entryOffset + 6);
    icon.writeUInt32LE(image.length, entryOffset + 8);
    icon.writeUInt32LE(offset, entryOffset + 12);
    image.copy(icon, offset);
    offset += image.length;
  });

  await fs.writeFile(appIconIcoPath, icon);
}

function createIconDib(size) {
  const scale = size <= 32 ? 8 : 4;
  const highSize = size * scale;
  const pixels = new Uint8ClampedArray(highSize * highSize * 4);
  const factor = size / 64;
  const compact = size <= 32;
  const lineWidth = (compact ? 6.4 : 4.8) * factor;
  const nodeRadius = (compact ? 9.7 : 8.4) * factor;
  const ringRadius = (compact ? 9.9 : 9.6) * factor;
  const ringWidth = (compact ? 4.1 : 3.2) * factor;

  drawLine(pixels, highSize, scale, cubicPoints(21.6 * factor, 42.4 * factor, 29.6 * factor, 34.4 * factor, 33.6 * factor, 29.6 * factor, 41.6 * factor, 21.6 * factor), lineWidth, [154, 163, 171, 255]);
  drawCircle(pixels, highSize, scale, 14.4 * factor, 49.6 * factor, nodeRadius, [110, 120, 130, 255]);
  drawRing(pixels, highSize, scale, 48 * factor, 16 * factor, ringRadius, ringWidth, [20, 23, 26, 255]);

  const rgba = downsample(pixels, size, scale);
  return encodeIconDib(rgba, size);
}

function cubicPoints(x0, y0, x1, y1, x2, y2, x3, y3) {
  const points = [];
  for (let step = 0; step <= 48; step += 1) {
    const t = step / 48;
    const mt = 1 - t;
    points.push({
      x: mt ** 3 * x0 + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3,
      y: mt ** 3 * y0 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3
    });
  }
  return points;
}

function drawLine(pixels, highSize, scale, points, width, color) {
  const radius = (width * scale) / 2;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance * scale * 1.5));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      drawDisk(pixels, highSize, previous.x * scale + dx * t * scale, previous.y * scale + dy * t * scale, radius, color);
    }
  }
}

function drawCircle(pixels, highSize, scale, cx, cy, radius, color) {
  drawDisk(pixels, highSize, cx * scale, cy * scale, radius * scale, color);
}

function drawRing(pixels, highSize, scale, cx, cy, radius, width, color) {
  drawDisk(pixels, highSize, cx * scale, cy * scale, (radius + width) * scale, color);
  drawDisk(pixels, highSize, cx * scale, cy * scale, Math.max(0, radius - width) * scale, [0, 0, 0, 0], true);
}

function drawRoundedRect(pixels, highSize, scale, x, y, width, height, radius, color) {
  drawRoundedRectPixels(pixels, highSize, x * scale, y * scale, width * scale, height * scale, radius * scale, color, false);
}

function drawRoundedRectOutline(pixels, highSize, scale, x, y, width, height, radius, strokeWidth, color) {
  drawRoundedRectPixels(pixels, highSize, x * scale, y * scale, width * scale, height * scale, radius * scale, color, false, strokeWidth * scale);
}

function drawRoundedRectPixels(pixels, highSize, x, y, width, height, radius, color, replace = false, strokeWidth = 0) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(highSize - 1, Math.ceil(x + width));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(highSize - 1, Math.ceil(y + height));
  const right = x + width;
  const bottom = y + height;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const centerX = px + 0.5;
      const centerY = py + 0.5;
      const dx = Math.max(x + radius - centerX, 0, centerX - (right - radius));
      const dy = Math.max(y + radius - centerY, 0, centerY - (bottom - radius));
      const inside = dx * dx + dy * dy <= radius * radius;
      if (!inside) continue;

      if (strokeWidth > 0) {
        const innerX = x + strokeWidth;
        const innerY = y + strokeWidth;
        const innerRight = right - strokeWidth;
        const innerBottom = bottom - strokeWidth;
        const innerRadius = Math.max(0, radius - strokeWidth);
        const innerDx = Math.max(innerX + innerRadius - centerX, 0, centerX - (innerRight - innerRadius));
        const innerDy = Math.max(innerY + innerRadius - centerY, 0, centerY - (innerBottom - innerRadius));
        const insideInner = innerDx * innerDx + innerDy * innerDy <= innerRadius * innerRadius;
        if (insideInner) continue;
      }

      const offset = (py * highSize + px) * 4;
      if (replace) {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = color[3];
      } else {
        blendPixel(pixels, offset, color);
      }
    }
  }
}

function drawDisk(pixels, highSize, cx, cy, radius, color, replace = false) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(highSize - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(highSize - 1, Math.ceil(cy + radius));
  const radiusSq = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > radiusSq) continue;
      const offset = (y * highSize + x) * 4;
      if (replace) {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = color[3];
      } else {
        blendPixel(pixels, offset, color);
      }
    }
  }
}

function blendPixel(pixels, offset, source) {
  const sourceAlpha = source[3] / 255;
  const targetAlpha = pixels[offset + 3] / 255;
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;

  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round((source[channel] * sourceAlpha + pixels[offset + channel] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  }
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function downsample(source, size, scale) {
  const target = Buffer.alloc(size * size * 4);
  const highSize = size * scale;
  const sampleCount = scale * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < scale; sampleY += 1) {
        for (let sampleX = 0; sampleX < scale; sampleX += 1) {
          const sourceOffset = ((y * scale + sampleY) * highSize + x * scale + sampleX) * 4;
          totals[0] += source[sourceOffset];
          totals[1] += source[sourceOffset + 1];
          totals[2] += source[sourceOffset + 2];
          totals[3] += source[sourceOffset + 3];
        }
      }
      const targetOffset = (y * size + x) * 4;
      target[targetOffset] = Math.round(totals[0] / sampleCount);
      target[targetOffset + 1] = Math.round(totals[1] / sampleCount);
      target[targetOffset + 2] = Math.round(totals[2] / sampleCount);
      target[targetOffset + 3] = Math.round(totals[3] / sampleCount);
    }
  }

  return target;
}

function encodeIconDib(rgba, size) {
  const rowBytes = size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const xorBytes = rowBytes * size;
  const maskBytes = maskRowBytes * size;
  const dib = Buffer.alloc(40 + xorBytes + maskBytes);

  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xorBytes + maskBytes, 20);

  for (let y = 0; y < size; y += 1) {
    const sourceY = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (sourceY * size + x) * 4;
      const targetOffset = 40 + y * rowBytes + x * 4;
      dib[targetOffset] = rgba[sourceOffset + 2];
      dib[targetOffset + 1] = rgba[sourceOffset + 1];
      dib[targetOffset + 2] = rgba[sourceOffset];
      dib[targetOffset + 3] = rgba[sourceOffset + 3];
    }
  }

  return dib;
}

async function setExecutableMetadata(executablePath) {
  let rcedit;
  try {
    rcedit = require("rcedit");
  } catch {
    throw new Error("The portable Windows build needs the dev dependency 'rcedit' to embed the Tether icon into Tether.exe.");
  }

  const sourcePackage = require(path.join(root, "package.json"));
  await rcedit(executablePath, {
    icon: appIconIcoPath,
    "file-version": sourcePackage.version,
    "product-version": sourcePackage.version,
    "version-string": {
      CompanyName: "Tether",
      FileDescription: "Tether",
      InternalName: "Tether",
      OriginalFilename: "Tether.exe",
      ProductName: "Tether"
    }
  });
}

async function writePortablePackageJson() {
  const sourcePackage = require(path.join(root, "package.json"));
  const portablePackage = {
    name: sourcePackage.name,
    productName: "Tether",
    version: sourcePackage.version,
    private: true,
    main: "src/main/main.cjs"
  };

  await fs.writeFile(
    path.join(appDir, "package.json"),
    `${JSON.stringify(portablePackage, null, 2)}\n`,
    "utf8"
  );
}

function collectRuntimePackageNames(entryPackageNames) {
  const seen = new Set();
  const ordered = [];

  function visit(packageName) {
    if (!packageName || seen.has(packageName)) return;
    seen.add(packageName);
    ordered.push(packageName);

    const packageJson = require(path.join(packageRoot(packageName), "package.json"));
    for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
      visit(dependencyName);
    }
  }

  entryPackageNames.forEach(visit);
  return ordered;
}

async function copyRuntimePackage(packageName) {
  const source = packageRoot(packageName);
  const destination = path.join(appNodeModulesDir, ...packageName.split("/"));

  await fs.mkdir(path.dirname(destination), { recursive: true });

  await fs.cp(source, destination, {
    recursive: true,
    filter: (entryPath) => shouldCopyRuntimeEntry(packageName, source, entryPath)
  });
}

async function pruneRuntimeArtifacts() {
  await fs.rm(path.join(appNodeModulesDir, "ssh2", "lib", "protocol", "crypto", "build"), {
    recursive: true,
    force: true
  });
}

function packageRoot(packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function shouldCopyRuntimeEntry(packageName, packageRoot, entryPath) {
  const relative = path.relative(packageRoot, entryPath).replace(/\\/g, "/");
  if (!relative) return true;

  const parts = relative.split("/");
  if (parts.some((part) => part === ".git" || part === ".github")) return false;
  if (parts.some((part) => part === "test" || part === "tests" || part === "coverage")) return false;
  if (parts.some((part) => part === "example" || part === "examples" || part === "benchmark" || part === "benchmarks")) {
    return false;
  }

  // Avoid copying Node-built optional native binaries into Electron; ssh2 catches
  // their absence and uses the JS/Node crypto fallback.
  if (packageName === "ssh2" && relative.startsWith("lib/protocol/crypto/build")) return false;

  return true;
}
