const path = require("path");
const fs = require("fs/promises");
const { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const { startServer } = require("./server");

let mainWindow = null;
let serverInstance = null;
let tray = null;
let appSettings = { startHidden: false };

function iconPath() {
  return path.join(__dirname, "build", "icon.ico");
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updates:status", payload);
  }
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    appSettings = { startHidden: Boolean(parsed && parsed.startHidden) };
  } catch (_err) {
    appSettings = { startHidden: false };
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(appSettings, null, 2), "utf-8");
}

function isWindowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.hide();
}

function toggleMainWindow() {
  if (isWindowVisible()) {
    hideMainWindow();
  } else {
    showMainWindow();
  }

  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function buildMenu() {
  const template = [
    {
      label: app.getName(),
      submenu: [
        { label: "Show Window", click: showMainWindow },
        { label: "Hide Window", click: hideMainWindow },
        {
          type: "checkbox",
          label: "Start Hidden on Launch",
          checked: Boolean(appSettings.startHidden),
          click: async (menuItem) => {
            appSettings.startHidden = Boolean(menuItem.checked);
            await saveSettings();
            refreshMenus();
          }
        },
        { type: "separator" },
        {
          label: "Check for Updates",
          click: () => {
            if (!app.isPackaged) {
              sendUpdateStatus({ state: "unavailable", message: "Updates are only available in packaged builds." });
              dialog.showMessageBox({
                type: "info",
                title: "Updates",
                message: "Updates are only available in packaged builds.",
                detail: "Build and install the Windows app package to receive GitHub-based updates."
              });
              return;
            }

            autoUpdater.checkForUpdates().catch((error) => {
              sendUpdateStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
              dialog.showMessageBox({
                type: "error",
                title: "Update check failed",
                message: "Unable to check for updates.",
                detail: error instanceof Error ? error.message : String(error)
              });
            });
          }
        },
        {
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: "info",
              title: `About ${app.getName()}`,
              message: app.getName(),
              detail: `Version ${app.getVersion()}\nStandalone LAN device scanner and desktop shell.`
            });
          }
        },
        { type: "separator" },
        { role: "quit" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTrayMenu() {
  const template = [
    { label: isWindowVisible() ? "Hide Window" : "Show Window", click: toggleMainWindow },
    {
      type: "checkbox",
      label: "Start Hidden on Launch",
      checked: Boolean(appSettings.startHidden),
      click: async (menuItem) => {
        appSettings.startHidden = Boolean(menuItem.checked);
        await saveSettings();
        refreshMenus();
      }
    },
    {
      label: `About ${app.getName()}`,
      click: () => {
        dialog.showMessageBox({
          type: "info",
          title: `About ${app.getName()}`,
          message: app.getName(),
          detail: `Version ${app.getVersion()}\nStandalone LAN device scanner and desktop shell.`
        });
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ];

  return Menu.buildFromTemplate(template);
}

function buildTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(nativeImage.createFromPath(iconPath()));
  tray.setToolTip(`${app.getName()} v${app.getVersion()}`);
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleMainWindow);
  tray.on("right-click", () => {
    tray.popUpContextMenu(buildTrayMenu());
  });

  return tray;
}

function refreshMenus() {
  buildMenu();
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

async function createWindow() {
  const started = await startServer(0);
  serverInstance = started.server;
  const { port } = started;
  const appName = app.getName();
  const appVersion = app.getVersion();
  const shouldStartHidden = Boolean(appSettings.startHidden);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#091015",
    title: `${appName} v${appVersion}`,
    show: !shouldStartHidden,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);

  if (!shouldStartHidden) {
    mainWindow.show();
    mainWindow.focus();
  }

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideMainWindow();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function configureAutoUpdates() {
  ipcMain.handle("updates:check", async () => {
    if (!app.isPackaged) {
      sendUpdateStatus({ state: "unavailable", message: "Browser" });
      return null;
    }

    sendUpdateStatus({ state: "checking", message: "Checking..." });
    return autoUpdater.checkForUpdates();
  });

  if (!app.isPackaged) {
    sendUpdateStatus({ state: "unavailable", message: "Browser" });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus({ state: "checking", message: "Checking..." });
  });

  autoUpdater.on("update-available", () => {
    sendUpdateStatus({ state: "available", message: "Update available" });
    dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: "A new version is downloading in the background.",
      detail: "You will be prompted to restart once the update is ready."
    });
  });

  autoUpdater.on("update-not-available", () => {
    sendUpdateStatus({ state: "idle", message: "Up to date" });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`${app.getName()} v${app.getVersion()}`);
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus({
      state: "downloading",
      message: `DL ${Math.round(progress.percent || 0)}%`
    });
  });

  autoUpdater.on("error", (error) => {
    sendUpdateStatus({ state: "unavailable", message: "Updates unavailable" });
    console.error("Auto-update error:", error);
  });

  autoUpdater.on("update-downloaded", () => {
    sendUpdateStatus({ state: "ready", message: "Update ready to install" });
    dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update downloaded",
        message: "A new version is ready to install.",
        detail: "Restart now to apply the update."
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

}

app.whenReady().then(() => {
  loadSettings()
    .then(() => {
      buildMenu();
      buildTray();
      configureAutoUpdates();
      if (!app.isPackaged) {
        sendUpdateStatus({ state: "unavailable", message: "Desktop build only" });
      }
      return createWindow();
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });

  app.on("activate", () => {
    if (mainWindow) {
      showMainWindow();
      return;
    }

    createWindow().catch((error) => {
      console.error(error);
      app.quit();
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    return;
  }

  if (!app.isQuitting) {
    return;
  }

  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverInstance && typeof serverInstance.close === "function") {
    serverInstance.close();
    serverInstance = null;
  }
});
