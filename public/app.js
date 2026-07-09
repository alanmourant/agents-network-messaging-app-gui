const refs = {
  interfaceSelect: document.getElementById("interfaceSelect"),
  cidrSelect: document.getElementById("cidrSelect"),
  timeoutInput: document.getElementById("timeoutInput"),
  concurrencyInput: document.getElementById("concurrencyInput"),
  resolveHostnamesToggle: document.getElementById("resolveHostnamesToggle"),
  scanBtn: document.getElementById("scanBtn"),
  resetScanBtn: document.getElementById("resetScanBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  statusText: document.getElementById("statusText"),
  scannedHostCount: document.getElementById("scannedHostCount"),
  onlineCount: document.getElementById("onlineCount"),
  seenCount: document.getElementById("seenCount"),
  duration: document.getElementById("duration"),
  resultsBody: document.getElementById("resultsBody"),
  appBuildInfo: document.getElementById("appBuildInfo"),
  updateBadge: document.getElementById("updateBadge"),
  homeScreenTipBtn: document.getElementById("homeScreenTipBtn"),
  themeSelect: document.getElementById("themeSelect")
};

let interfaces = [];
let latestScanDevices = [];
let updateStatusUnsubscribe = null;
const DEFAULT_TIMEOUT_MS = 120;
const DEFAULT_CONCURRENCY = 128;
const THEME_STORAGE_KEY = "lan-device-finder-theme";

function isDesktopBuild() {
  return Boolean(window.lanDeviceFinder && window.lanDeviceFinder.updates);
}

function isIpadSafari() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const isIOSLike = /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return isIOSLike && isSafari;
}

function applyFooterPlatformMode() {
  document.body.classList.toggle("ios-safari", isIpadSafari());
}

function wireHomeScreenTip() {
  if (!refs.homeScreenTipBtn) {
    return;
  }

  refs.homeScreenTipBtn.addEventListener("click", () => {
    setStatus("IPAD: Safari- tap Share (square with up arrow), then Add to Home Screen");
  });
}

function applyTheme(themeValue) {
  const validThemes = new Set(["earth", "forest", "sandstone", "night-contrast"]);
  const theme = validThemes.has(themeValue) ? themeValue : "earth";
  document.body.dataset.theme = theme;
  if (refs.themeSelect) {
    refs.themeSelect.value = theme;
  }
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function wireThemePicker() {
  if (!refs.themeSelect) {
    return;
  }

  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "earth";
  applyTheme(savedTheme);

  refs.themeSelect.addEventListener("change", () => {
    applyTheme(refs.themeSelect.value);
  });
}

function ipv4ToInt(ip) {
  const parts = String(ip || "").split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
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

function cidrFromAddress(ipAddress, prefix) {
  const ipInt = ipv4ToInt(ipAddress);
  if (ipInt === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    return null;
  }

  const mask = (~((1 << (32 - prefix)) - 1)) >>> 0;
  const network = ipInt & mask;
  return `${intToIpv4(network)}/${prefix}`;
}

function renderCidrOptions() {
  const selectedInterface = interfaces.find((item) => item.id === refs.interfaceSelect.value) || interfaces[0] || null;
  const prefixes = [24, 25, 26, 27, 28, 29, 30];
  const options = new Map();

  refs.cidrSelect.innerHTML = "";

  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "Use interface subnet (auto)";
  refs.cidrSelect.appendChild(autoOption);

  if (!selectedInterface) {
    return;
  }

  for (const prefix of prefixes) {
    const cidr = cidrFromAddress(selectedInterface.address, prefix);
    if (!cidr || options.has(cidr)) {
      continue;
    }
    options.set(cidr, true);

    const option = document.createElement("option");
    option.value = cidr;
    option.textContent = cidr;
    refs.cidrSelect.appendChild(option);
  }
}

function setStatus(message, isError = false) {
  refs.statusText.textContent = message;
  refs.statusText.classList.toggle("error", Boolean(isError));
}

function setLoading(isLoading) {
  refs.scanBtn.disabled = isLoading;
  refs.scanBtn.textContent = isLoading ? "Scanning..." : "Scan Network";
}

function setExportEnabled(enabled) {
  refs.exportCsvBtn.disabled = !enabled;
}

function resetScanView() {
  refs.timeoutInput.value = String(DEFAULT_TIMEOUT_MS);
  refs.concurrencyInput.value = String(DEFAULT_CONCURRENCY);
  refs.resolveHostnamesToggle.value = "off";
  refs.cidrSelect.value = "";

  if (interfaces.length > 0) {
    refs.interfaceSelect.selectedIndex = 0;
  }
  renderCidrOptions();

  latestScanDevices = [];
  updateMetrics({ scannedHostCount: 0, onlineCount: 0, seenCount: 0, durationMs: 0 });
  refs.resultsBody.innerHTML = '<tr><td colspan="5" class="placeholder">No scan data yet.</td></tr>';
  setExportEnabled(false);

  if (interfaces.length > 0) {
    setStatus("Reset complete. Select scan settings and press Scan Network.");
  } else {
    setStatus("Reset complete.");
  }
}

function setUpdateBadge(state, message) {
  const fallbackLabel = isDesktopBuild() ? "Updates" : "Browser";
  const normalizedState = state || (isDesktopBuild() ? "idle" : "unavailable");
  refs.updateBadge.dataset.state = normalizedState;

  const fallbackByState = {
    checking: "Checking...",
    available: "Update available",
    ready: "Update ready",
    error: "Updates unavailable",
    unavailable: "Updates unavailable"
  };
  const label = message || fallbackByState[normalizedState] || fallbackLabel;
  refs.updateBadge.textContent = label;
  refs.updateBadge.disabled = !isDesktopBuild() || normalizedState === "checking";
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(devices) {
  const header = ["status", "ip", "mac", "hostname", "source"];
  const rows = devices.map((device) => [
    device.status || "",
    device.ip || "",
    device.mac || "",
    device.hostname || "",
    device.source || ""
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function timeStampForFileName() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function exportCsv() {
  if (!Array.isArray(latestScanDevices) || latestScanDevices.length === 0) {
    setStatus("No scan results to export yet.", true);
    return;
  }

  const csv = buildCsv(latestScanDevices);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `lan-devices-${timeStampForFileName()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`CSV exported with ${latestScanDevices.length} rows.`);
}

function updateMetrics(scanResult) {
  refs.scannedHostCount.textContent = String(scanResult.scannedHostCount || 0);
  refs.onlineCount.textContent = String(scanResult.onlineCount || 0);
  refs.seenCount.textContent = String(scanResult.seenCount || 0);
  refs.duration.textContent = `${scanResult.durationMs || 0} ms`;
}

function renderResults(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    refs.resultsBody.innerHTML = '<tr><td colspan="5" class="placeholder">No devices detected.</td></tr>';
    return;
  }

  const rows = devices
    .map((device) => {
      const statusClass = device.status === "online" ? "status-online" : "status-seen";
      const statusLabel = device.status === "online" ? "Online" : "Seen";
      const mac = device.mac || "-";
      const hostname = device.hostname || "-";
      const source = device.source || "-";

      return `
        <tr>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td>${device.ip}</td>
          <td class="mono">${mac}</td>
          <td>${hostname}</td>
          <td>${source}</td>
        </tr>
      `;
    })
    .join("");

  refs.resultsBody.innerHTML = rows;
}

function renderInterfaces() {
  refs.interfaceSelect.innerHTML = "";
  if (interfaces.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No interface detected";
    refs.interfaceSelect.appendChild(option);
    renderCidrOptions();
    return;
  }

  for (const item of interfaces) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.name} - ${item.address} (${item.netmask})`;
    refs.interfaceSelect.appendChild(option);
  }

  renderCidrOptions();
}

async function loadInterfaces() {
  setStatus("Loading interfaces...");

  const response = await fetch("/api/interfaces");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Failed to load interfaces.");
  }

  interfaces = Array.isArray(payload.interfaces) ? payload.interfaces : [];
  renderInterfaces();

  if (interfaces.length > 0) {
    setStatus("Select scan settings and press Scan Network.");
  } else {
    setStatus("No active IPv4 interface found on this machine.", true);
  }
}

async function loadAppInfo() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load app info.");
    }

    const name = payload.productName || "LAN Device Finder";
    const version = payload.version || "0.0.0";
    refs.appBuildInfo.textContent = `${name} v${version}`;
  } catch (_err) {
    refs.appBuildInfo.textContent = "LAN Device Finder";
  }
}

function wireUpdateBadge() {
  if (!isDesktopBuild()) {
    setUpdateBadge("unavailable", "Browser");
    return;
  }

  setUpdateBadge("checking", "Checking...");

  updateStatusUnsubscribe = window.lanDeviceFinder.updates.onStatus((payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.state === "error") {
      setUpdateBadge("unavailable", "Updates unavailable");
      return;
    }

    setUpdateBadge(payload.state, payload.message);

    if (payload.state === "available") {
      showUpdateNotice("Update available", "A new version is ready. Use the badge or app menu to check again if needed.");
    }

    if (payload.state === "ready") {
      showUpdateNotice("Update ready", "Restart the app to install the downloaded update.");
    }

  });

  refs.updateBadge.addEventListener("click", async () => {
    try {
      setUpdateBadge("checking", "Checking...");
      await window.lanDeviceFinder.updates.check();
    } catch (_err) {
      setUpdateBadge("unavailable", "Updates unavailable");
    }
  });

  window.lanDeviceFinder.updates.check().catch(() => {
    setUpdateBadge("unavailable", "Updates unavailable");
  });
}

function showUpdateNotice(title, detail) {
  setStatus(`${title}: ${detail}`, false);
}

async function runScan() {
  try {
    setLoading(true);
    setExportEnabled(false);
    setStatus("Running network scan...");

    const body = {
      interfaceId: refs.interfaceSelect.value,
      cidr: refs.cidrSelect.value,
      timeoutMs: Number.parseInt(refs.timeoutInput.value, 10),
      concurrency: Number.parseInt(refs.concurrencyInput.value, 10),
      resolveHostnames: refs.resolveHostnamesToggle.value === "on"
    };

    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Scan failed.");
    }

    updateMetrics(payload);
  latestScanDevices = Array.isArray(payload.devices) ? payload.devices : [];
  renderResults(latestScanDevices);
  setExportEnabled(latestScanDevices.length > 0);

    const iface = payload.network?.interface;
    const ifaceLabel = iface ? `${iface.name} ${iface.address}` : "selected interface";
    const wasTruncated = Boolean(payload.truncated);
    const truncationNote = wasTruncated
      ? ` Range truncated to first ${payload.scannedHostCount || 0} hosts (max ${payload.maxScanHosts || 1024}).`
      : "";

    if (payload.timedOut) {
      setStatus(
        `Scan reached ${payload.maxDurationMs || 10000}ms limit on ${ifaceLabel}. Partial results: ${(payload.devices || []).length} devices.${truncationNote}`
      );
    } else {
      setStatus(`Scan complete on ${ifaceLabel}. Found ${(payload.devices || []).length} devices.${truncationNote}`);
    }
  } catch (err) {
    latestScanDevices = [];
    setExportEnabled(false);
    setStatus(err instanceof Error ? err.message : "Scan failed.", true);
  } finally {
    setLoading(false);
  }
}

refs.scanBtn.addEventListener("click", runScan);
refs.resetScanBtn.addEventListener("click", resetScanView);
refs.exportCsvBtn.addEventListener("click", exportCsv);
refs.interfaceSelect.addEventListener("change", renderCidrOptions);
setExportEnabled(false);

loadInterfaces().catch((err) => {
  setStatus(err instanceof Error ? err.message : "Could not initialize app.", true);
});

loadAppInfo();
wireThemePicker();
applyFooterPlatformMode();
wireHomeScreenTip();
wireUpdateBadge();
