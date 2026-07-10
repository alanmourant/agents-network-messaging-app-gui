const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const fs = require("fs");
const dns = require("dns").promises;
const express = require("express");
const { execFile } = require("child_process");
const packageJson = require("./package.json");

const app = express();
const serverConfig = createServerConfig();
const server = serverConfig.server;
let listeningPromise = null;

const PORT = process.env.PORT || 3000;
const DEFAULT_CONCURRENCY = 128;
const DEFAULT_TIMEOUT_MS = 120;
const MIN_TIMEOUT_MS = 80;
const MAX_TIMEOUT_MS = 600;
const SCAN_BATCH_SIZE = 256;
const MAX_SCAN_HOSTS = 1024;
const MAX_SCAN_DURATION_MS = 10000;

function createTlsOptions() {
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;
  const caPath = process.env.SSL_CA_PATH;

  if (!keyPath || !certPath) {
    return null;
  }

  try {
    const options = {
      key: fs.readFileSync(path.resolve(keyPath)),
      cert: fs.readFileSync(path.resolve(certPath))
    };

    if (caPath) {
      options.ca = fs.readFileSync(path.resolve(caPath));
    }

    return options;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[server] HTTPS disabled. Could not load TLS certificate files: ${detail}`);
    return null;
  }
}

function createServerConfig() {
  const tlsOptions = createTlsOptions();
  if (tlsOptions) {
    return {
      protocol: "https",
      secure: true,
      server: https.createServer(tlsOptions, app)
    };
  }

  return {
    protocol: "http",
    secure: false,
    server: http.createServer(app)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function ipv4ToInt(ip) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error("Invalid IPv4 address.");
  }

  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0);
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join(".");
}

function normalizeMac(mac) {
  if (!mac || typeof mac !== "string") {
    return null;
  }
  const cleaned = mac.trim().toLowerCase().replaceAll("-", ":");
  if (cleaned === "<incomplete>") {
    return null;
  }
  return cleaned;
}

function toInterfaceCandidates() {
  const interfaces = os.networkInterfaces();
  const list = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses || []) {
      if (!addr || addr.family !== "IPv4" || addr.internal || !addr.address || !addr.netmask) {
        continue;
      }

      list.push({
        id: `${name}|${addr.address}`,
        name,
        address: addr.address,
        netmask: addr.netmask
      });
    }
  }

  return list;
}

function hostRangeFromCidr(cidr) {
  const trimmed = typeof cidr === "string" ? cidr.trim() : "";
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(trimmed);
  if (!match) {
    throw new Error("CIDR must look like 192.168.1.0/24");
  }

  const baseIp = match[1];
  const prefix = Number.parseInt(match[2], 10);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new Error("CIDR prefix must be between /1 and /30.");
  }

  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const network = (ipv4ToInt(baseIp) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  return {
    network,
    broadcast,
    firstHost: (network + 1) >>> 0,
    lastHost: (broadcast - 1) >>> 0
  };
}

function hostRangeFromInterface(candidate) {
  const ip = ipv4ToInt(candidate.address);
  const mask = ipv4ToInt(candidate.netmask);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  return {
    network,
    broadcast,
    firstHost: (network + 1) >>> 0,
    lastHost: (broadcast - 1) >>> 0
  };
}

function runExecFile(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function pingHost(ipAddress, timeoutMs) {
  const isWindows = process.platform === "win32";
  const args = isWindows
    ? ["-n", "1", "-w", String(timeoutMs), ipAddress]
    : ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), ipAddress];

  const result = await runExecFile("ping", args, timeoutMs + 250);
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (!result.error) {
    return true;
  }

  return output.includes("ttl=") || output.includes("1 received") || output.includes("bytes from");
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = [];
  const size = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < size; i += 1) {
    workers.push(runner());
  }

  await Promise.all(workers);
  return results;
}

function* hostBatchGenerator(firstHost, lastHost, batchSize = SCAN_BATCH_SIZE) {
  let current = firstHost;
  while (current <= lastHost) {
    const batch = [];
    const end = Math.min(lastHost, current + batchSize - 1);
    for (let value = current; value <= end; value += 1) {
      batch.push(intToIpv4(value >>> 0));
    }
    yield batch;
    current = end + 1;
  }
}

function hostCountFromRange(range) {
  if (!range || range.firstHost > range.lastHost) {
    return 0;
  }
  return range.lastHost - range.firstHost + 1;
}

function ipInRange(ipAddress, range) {
  let ipInt;
  try {
    ipInt = ipv4ToInt(ipAddress);
  } catch (_err) {
    return false;
  }
  return ipInt >= range.firstHost && ipInt <= range.lastHost;
}

async function readArpTable() {
  const args = process.platform === "win32" ? ["-a"] : ["-an"];
  const result = await runExecFile("arp", args, 4000);
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  const entries = new Map();

  for (const line of lines) {
    const windowsMatch = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:-]{11,17})\s+(\w+)/);
    if (windowsMatch) {
      const ip = windowsMatch[1];
      entries.set(ip, {
        ip,
        mac: normalizeMac(windowsMatch[2]),
        source: "arp"
      });
      continue;
    }

    const macStyleMatch = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]{17}|<incomplete>)/i);
    if (macStyleMatch) {
      const ip = macStyleMatch[1];
      entries.set(ip, {
        ip,
        mac: normalizeMac(macStyleMatch[2]),
        source: "arp"
      });
      continue;
    }

    const linuxMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+ether\s+([0-9a-fA-F:]{17})/i);
    if (linuxMatch) {
      const ip = linuxMatch[1];
      entries.set(ip, {
        ip,
        mac: normalizeMac(linuxMatch[2]),
        source: "arp"
      });
    }
  }

  return entries;
}

async function resolveHostName(ipAddress) {
  try {
    const names = await Promise.race([
      dns.reverse(ipAddress),
      new Promise((_, reject) => setTimeout(() => reject(new Error("reverse timeout")), 750))
    ]);

    if (Array.isArray(names) && names.length > 0) {
      return names[0];
    }
  } catch (_err) {
    return null;
  }
  return null;
}

async function resolveHostNameQuick(ipAddress, timeoutMs = 250) {
  try {
    const names = await Promise.race([
      dns.reverse(ipAddress),
      new Promise((_, reject) => setTimeout(() => reject(new Error("reverse timeout")), timeoutMs))
    ]);

    if (Array.isArray(names) && names.length > 0) {
      return names[0];
    }
  } catch (_err) {
    return null;
  }
  return null;
}

function sortByIpAscending(a, b) {
  return ipv4ToInt(a.ip) - ipv4ToInt(b.ip);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: nowIso(),
    platform: process.platform,
    protocol: serverConfig.protocol,
    secure: serverConfig.secure,
    name: packageJson.name,
    version: packageJson.version,
    productName: packageJson.build?.productName || "LAN Device Finder"
  });
});

app.get("/api/interfaces", (_req, res) => {
  const candidates = toInterfaceCandidates();
  res.json({
    ts: nowIso(),
    interfaces: candidates
  });
});

app.post("/api/scan", async (req, res) => {
  const startedAt = Date.now();

  try {
    const candidates = toInterfaceCandidates();
    if (candidates.length === 0) {
      res.status(400).json({ error: "No active IPv4 network interfaces found." });
      return;
    }

    const requestedId = typeof req.body?.interfaceId === "string" ? req.body.interfaceId : "";
    const selected = candidates.find((item) => item.id === requestedId) || candidates[0];

    const requestedTimeout = Number.parseInt(String(req.body?.timeoutMs || DEFAULT_TIMEOUT_MS), 10);
    const timeoutMs = Number.isInteger(requestedTimeout)
      ? Math.max(MIN_TIMEOUT_MS, Math.min(requestedTimeout, MAX_TIMEOUT_MS))
      : DEFAULT_TIMEOUT_MS;

    const requestedConcurrency = Number.parseInt(String(req.body?.concurrency || DEFAULT_CONCURRENCY), 10);
    const concurrency = Number.isInteger(requestedConcurrency)
      ? Math.max(16, Math.min(requestedConcurrency, 256))
      : DEFAULT_CONCURRENCY;
    const resolveHostnames = Boolean(req.body?.resolveHostnames);

    let range;
    if (typeof req.body?.cidr === "string" && req.body.cidr.trim()) {
      range = hostRangeFromCidr(req.body.cidr);
    } else {
      range = hostRangeFromInterface(selected);
    }

    const requestedHostCount = hostCountFromRange(range);
    if (requestedHostCount === 0) {
      res.status(400).json({ error: "No hosts available to scan." });
      return;
    }
    let truncated = false;
    if (requestedHostCount > MAX_SCAN_HOSTS) {
      range = {
        ...range,
        lastHost: range.firstHost + MAX_SCAN_HOSTS - 1
      };
      truncated = true;
    }

    const scannedHostCount = hostCountFromRange(range);

    const aliveMap = new Map();
    let timedOut = false;

    for (const batch of hostBatchGenerator(range.firstHost, range.lastHost)) {
      if (Date.now() - startedAt >= MAX_SCAN_DURATION_MS) {
        timedOut = true;
        break;
      }

      const pingResults = await runPool(batch, concurrency, async (hostIp) => {
        const online = await pingHost(hostIp, timeoutMs);
        return { ip: hostIp, online };
      });

      for (const item of pingResults) {
        if (item.online) {
          aliveMap.set(item.ip, {
            ip: item.ip,
            status: "online",
            source: "ping"
          });
        }
      }
    }

    const arpEntries = await readArpTable();
    for (const [ip, arpData] of arpEntries.entries()) {
      if (!aliveMap.has(ip) && ipInRange(ip, range)) {
        aliveMap.set(ip, {
          ip,
          status: "seen",
          source: "arp"
        });
      }

      if (aliveMap.has(ip)) {
        const current = aliveMap.get(ip);
        current.mac = arpData.mac || current.mac || null;
      }
    }

    const devices = Array.from(aliveMap.values()).sort(sortByIpAscending);

    if (resolveHostnames) {
      await runPool(devices, 48, async (device) => {
        device.hostname = await resolveHostNameQuick(device.ip, 220);
        if (!device.mac) {
          device.mac = null;
        }
        return device;
      });
    } else {
      for (const device of devices) {
        device.hostname = null;
        if (!device.mac) {
          device.mac = null;
        }
      }
    }

    const durationMs = Date.now() - startedAt;

    res.json({
      ts: nowIso(),
      durationMs,
      timedOut,
      complete: !timedOut,
      maxDurationMs: MAX_SCAN_DURATION_MS,
      truncated,
      requestedHostCount,
      maxScanHosts: MAX_SCAN_HOSTS,
      scannedHostCount,
      onlineCount: devices.filter((item) => item.status === "online").length,
      seenCount: devices.filter((item) => item.status === "seen").length,
      network: {
        interface: selected,
        cidr: typeof req.body?.cidr === "string" && req.body.cidr.trim() ? req.body.cidr.trim() : null
      },
      devices
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Scan failed"
    });
  }
});

function startServer(port = PORT) {
  if (listeningPromise) {
    return listeningPromise;
  }

  listeningPromise = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const baseUrl = `${serverConfig.protocol}://localhost:${actualPort}`;
      console.log(`[server] LAN scanner available at ${baseUrl}`);
      resolve({
        server,
        port: actualPort,
        protocol: serverConfig.protocol,
        secure: serverConfig.secure,
        baseUrl
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });

  return listeningPromise;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  startServer
};
