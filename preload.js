const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lanDeviceFinder", {
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
    onStatus: (callback) => {
      if (typeof callback !== "function") {
        return () => {};
      }

      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("updates:status", handler);
      return () => {
        ipcRenderer.removeListener("updates:status", handler);
      };
    }
  }
});