const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const MAX_FILES = 1500;
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache"]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0c",
    title: "GazCode",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile("index.html");

  // "Open preview in new tab" uses a blob: URL; anything on the web opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("blob:") || url.startsWith("about:")) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Unsaved edits: the page sets beforeunload, Electron needs us to ask.
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "You have edits that haven't been saved to disk.",
      detail: "If you leave now, they will be lost.",
    });
    if (choice === 0) event.preventDefault(); // ignore the block -> window closes
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  // No File > Close accelerator, so Ctrl/Cmd+W stays "close tab" inside the editor.
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ file IPC */
const toBuffer = (data) => (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));

ipcMain.handle("disk:openFiles", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  if (res.canceled) return [];
  return Promise.all(
    res.filePaths.map(async (p) => ({ path: p, name: path.basename(p), bytes: await fs.readFile(p) }))
  );
});

async function walk(dir, rel, state) {
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const it of items) {
    if (state.files.length >= MAX_FILES) {
      state.skipped++;
      continue;
    }
    const abs = path.join(dir, it.name);
    const r = rel ? rel + "/" + it.name : it.name;
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      await walk(abs, r, state);
    } else if (it.isFile()) {
      if (it.name === ".DS_Store") continue;
      const st = await fs.stat(abs);
      if (st.size > MAX_BYTES) {
        state.skipped++;
        continue;
      }
      state.files.push({ rel: r, abs, bytes: await fs.readFile(abs) });
    }
  }
}

ipcMain.handle("disk:openFolder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  const state = { files: [], skipped: 0 };
  await walk(root, "", state);
  return { root, name: path.basename(root), files: state.files, skipped: state.skipped };
});

ipcMain.handle("disk:readFile", async (_e, p) => {
  if (typeof p !== "string") return null;
  try {
    return await fs.readFile(p);
  } catch (e) {
    return null;
  }
});

ipcMain.handle("disk:writeFile", async (_e, p, data) => {
  if (typeof p !== "string" || !path.isAbsolute(p)) throw new Error("Invalid path");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, toBuffer(data));
  return true;
});

ipcMain.handle("disk:saveAs", async (event, name, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, { defaultPath: String(name || "untitled.txt") });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, toBuffer(data));
  return res.filePath;
});

/* ------------------------------------------------------------------- lifecycle */
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
