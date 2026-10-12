/* ==========================================================================
   GazCode — disk.js
   Open files / folders from disk and save straight back to them.

   Backends (picked automatically):
     desktop  Electron, via window.gazDesktop (see preload.js)
     web      File System Access API (Chrome, Edge, Brave, Opera, ChromeOS)
     none     Firefox / Safari — Open still works, Save falls back to download

   Load this AFTER app.js (last <script> before </body>).
   Exposes: window.GZ.disk
   ========================================================================== */
(function () {
  "use strict";
  const GZ = window.GZ;
  if (!GZ || !GZ.app) {
    console.error("[gazcode] disk.js must be loaded after app.js");
    return;
  }
  const U = GZ.util;
  const P = GZ.projects;
  const app = GZ.app;

  const desk = window.gazDesktop || null;
  const hasFS =
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showSaveFilePicker === "function" &&
    typeof window.showDirectoryPicker === "function";
  const MODE = desk ? "desktop" : hasFS ? "web" : "none";

  const MAX_FILES = 1500;
  const MAX_BYTES = 5 * 1024 * 1024;
  const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache"]);

  /* New setting: also write to disk automatically while typing (off by default). */
  if (GZ.settings.DEFAULTS.autoSaveToDisk === undefined) GZ.settings.DEFAULTS.autoSaveToDisk = false;
  if (GZ.settings.values.autoSaveToDisk === undefined) GZ.settings.values.autoSaveToDisk = false;

  /* Existing bug shim: app.js calls GZ.onTabActivate on rename. */
  if (!GZ.onTabActivate) GZ.onTabActivate = (id) => app.onTabActivate(id);

  /* ------------------------------------------------------------------------ */
  /* Link storage                                                              */
  /* desktop: node.diskPath (string) and project.diskRoot live in the project  */
  /* web:     FileSystemHandles can't be JSON-stringified, so they live in a   */
  /*          Map that is mirrored into IndexedDB (handles are structured-     */
  /*          cloneable).                                                      */
  /* ------------------------------------------------------------------------ */
  const fileHandles = new Map(); // nodeId -> FileSystemFileHandle
  const rootHandles = new Map(); // projectId -> FileSystemDirectoryHandle
  let persistTimer = null;

  function persistHandles() {
    if (MODE !== "web") return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      GZ.storage
        .idbSet("diskHandles", {
          files: Object.fromEntries(fileHandles),
          roots: Object.fromEntries(rootHandles),
        })
        .catch(() => {});
    }, 300);
  }

  (async function restoreHandles() {
    if (MODE !== "web") return;
    try {
      const saved = await GZ.storage.idbGet("diskHandles");
      if (saved) {
        Object.entries(saved.files || {}).forEach(([k, v]) => fileHandles.set(k, v));
        Object.entries(saved.roots || {}).forEach(([k, v]) => rootHandles.set(k, v));
      }
    } catch (e) {
      console.warn("[gazcode] could not restore file handles", e);
    }
    updateStatus();
  })();

  function isLinked(node) {
    return !!node && (!!node.diskPath || fileHandles.has(node.id));
  }
  function hasRoot(project) {
    return !!project && (!!project.diskRoot || rootHandles.has(project.id));
  }
  function linkLabel(node) {
    if (node.diskPath) return node.diskPath;
    const h = fileHandles.get(node.id);
    return h ? h.name : node.name;
  }
  function unlink(node) {
    delete node.diskPath;
    fileHandles.delete(node.id);
    if (node.type === "folder") {
      P.children(app.project, node.id).forEach(unlink);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Bytes <-> content                                                         */
  /* ------------------------------------------------------------------------ */
  const MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
    avif: "image/avif", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
  };

  function bytesToDataUrl(name, bytes) {
    const mime = MIME[U.ext(name)] || "application/octet-stream";
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  function hasNul(bytes) {
    const n = Math.min(bytes.length, 1024);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }

  /** Turn raw file bytes into node content. The editor works in LF, so CRLF is
   *  normalised on read and restored on write (node.eol). */
  function decode(name, bytes) {
    if (U.isBinary(name)) return { binary: true, content: bytesToDataUrl(name, bytes) };
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const crlf = text.indexOf("\r\n") !== -1;
    return { binary: false, content: text.replace(/\r\n/g, "\n"), eol: crlf ? "crlf" : "lf" };
  }

  function payloadFor(node) {
    if (node.binary) return app.nodeToBytes(node);
    let text = node.content == null ? "" : String(node.content);
    if (node.eol === "crlf") text = text.replace(/\n/g, "\r\n");
    return text;
  }

  function applyDecoded(node, d) {
    node.content = d.content;
    node.binary = d.binary;
    if (d.eol) node.eol = d.eol;
    GZ.tabs.setDirty(node.id, false);
    if (GZ.tabs.activeId === node.id) app.onTabActivate(node.id);
  }

  /* ------------------------------------------------------------------------ */
  /* Permissions + low-level writes (web)                                      */
  /* ------------------------------------------------------------------------ */
  async function perm(handle, mode, request) {
    const opts = { mode };
    try {
      if ((await handle.queryPermission(opts)) === "granted") return true;
      if (!request) return false;
      return (await handle.requestPermission(opts)) === "granted";
    } catch (e) {
      return false;
    }
  }

  async function writeHandle(handle, data) {
    const w = await handle.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) {}
      throw e;
    }
  }

  async function createInRoot(root, project, node) {
    const parts = P.pathOf(project, node.id).split("/");
    const name = parts.pop();
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir.getFileHandle(name, { create: true });
  }

  /* ------------------------------------------------------------------------ */
  /* Saving                                                                    */
  /* ------------------------------------------------------------------------ */
  /**
   * Write a node to the file it is linked to.
   * @returns "ok" | "unlinked" | "denied"
   */
  async function writeToDisk(node, opts) {
    const interactive = !opts || opts.interactive !== false;
    const project = app.project;
    const data = payloadFor(node);

    if (MODE === "desktop") {
      let p = node.diskPath;
      if (!p && project.diskRoot) {
        p = project.diskRoot.replace(/[\\/]+$/, "") + "/" + P.pathOf(project, node.id);
      }
      if (!p) return "unlinked";
      await desk.writeFile(p, data);
      node.diskPath = p;
      return "ok";
    }

    if (MODE === "web") {
      let h = fileHandles.get(node.id);
      if (!h && rootHandles.has(project.id)) {
        const root = rootHandles.get(project.id);
        if (!(await perm(root, "readwrite", interactive))) return "denied";
        h = await createInRoot(root, project, node);
      }
      if (!h) return "unlinked";
      if (!(await perm(h, "readwrite", interactive))) return "denied";
      await writeHandle(h, data);
      fileHandles.set(node.id, h);
      persistHandles();
      return "ok";
    }
    return "unlinked";
  }

  async function saveNode(node) {
    try {
      const r = await writeToDisk(node);
      if (r === "ok") GZ.tabs.setDirty(node.id, false);
      return r;
    } catch (e) {
      console.error(e);
      GZ.notify.error("Couldn't write to disk", e && e.message ? e.message : "Unknown error");
      return "error";
    }
  }

  function adoptName(node, name) {
    if (!name || name === node.name) return;
    P.renameNode(app.project, node.id, name);
    GZ.tabs.render();
    GZ.explorer.render();
  }

  /** Save As: choose a file on disk and link this node to it. */
  async function saveAs(node) {
    const data = payloadFor(node);
    if (MODE === "desktop") {
      const p = await desk.saveAs(node.name, data);
      if (!p) return false;
      node.diskPath = p;
      adoptName(node, p.split(/[\\/]/).pop());
      return true;
    }
    if (MODE === "web") {
      let h;
      try {
        h = await window.showSaveFilePicker({ suggestedName: node.name });
      } catch (e) {
        if (e && e.name === "AbortError") return false;
        throw e;
      }
      await writeHandle(h, data);
      fileHandles.set(node.id, h);
      persistHandles();
      adoptName(node, h.name);
      return true;
    }
    U.downloadBlob(new Blob([data]), node.name);
    return true;
  }

  async function saveAsActive() {
    const node = app.activeNode();
    if (!node) {
      GZ.notify.info("Open a file first");
      return;
    }
    try {
      if (!node.binary) node.content = GZ.editor.getValue();
      const ok = await saveAs(node);
      if (!ok) return;
      GZ.tabs.setDirty(node.id, false);
      P.touch(app.project);
      app.persist();
      if (MODE === "none") {
        GZ.notify.info("Downloaded", "This browser can't save in place. Use Chrome, Edge or the desktop app.");
      } else {
        GZ.notify.ok("Saved to disk", linkLabel(node));
      }
      updateStatus();
    } catch (e) {
      console.error(e);
      GZ.notify.error("Save As failed", e && e.message ? e.message : "Unknown error");
    }
  }

  /* Ctrl+S: project storage + the real file on disk. */
  app.saveActive = async function () {
    if (!this.project) return;
    const node = this.activeNode();
    if (!node) {
      GZ.notify.info("Nothing to save");
      return;
    }
    if (!node.binary) {
      let text = GZ.editor.getValue();
      if (GZ.settings.values.formatOnSave) {
        const before = text;
        text = app.formatText(text, node.lang || GZ.lang.detect(node.name));
        if (text !== before) {
          GZ.editor.setValue(text, { silent: true, keepCursor: true });
          GZ.notify.info("Formatted on save");
        }
      }
      node.content = text;
    }
    P.touch(this.project);
    this.persist();
    this.saveSession();

    const r = await saveNode(node);
    if (r === "ok") {
      GZ.notify.ok("Saved to disk", linkLabel(node));
    } else if (r === "unlinked") {
      GZ.tabs.setDirty(node.id, false);
      GZ.notify.show("Saved in project", {
        type: "info",
        description: "This file isn't on your disk yet.",
        duration: 6500,
        actionLabel: "Save to disk…",
        action: () => saveAsActive(),
      });
    } else if (r === "denied") {
      GZ.notify.warn("Disk access needed", "Allow write access when asked, then press Ctrl+S again.");
    }
    this.refreshStatusBar();
  };

  app.saveAll = async function () {
    this.persist();
    const ids = Array.from(GZ.tabs.dirty);
    let written = 0;
    for (const id of ids) {
      const node = P.getNode(this.project, id);
      if (!node) continue;
      if (isLinked(node) || hasRoot(this.project)) {
        if ((await saveNode(node)) === "ok") written++;
      } else {
        GZ.tabs.setDirty(id, false);
      }
    }
    GZ.tabs.render();
    GZ.notify.ok(written ? `Saved ${U.pluralize(written, "file")} to disk` : "All changes saved");
    this.refreshStatusBar();
  };

  /* Optional: write to disk automatically ~1s after you stop typing. */
  const pending = new Set();
  let autoTimer = null;

  async function flushAuto() {
    const ids = Array.from(pending);
    pending.clear();
    for (const id of ids) {
      const node = app.project && P.getNode(app.project, id);
      if (!node || !isLinked(node)) continue;
      try {
        if ((await writeToDisk(node, { interactive: false })) === "ok") GZ.tabs.setDirty(id, false);
      } catch (e) {
        console.warn("[gazcode] auto-save to disk failed", e);
      }
    }
    updateStatus();
  }

  const origChange = app.onEditorChange;
  app.onEditorChange = function (text) {
    origChange.call(this, text);
    if (!GZ.settings.values.autoSaveToDisk) return;
    if (GZ.tabs.activeId) pending.add(GZ.tabs.activeId);
    clearTimeout(autoTimer);
    autoTimer = setTimeout(flushAuto, 900);
  };

  /* ------------------------------------------------------------------------ */
  /* Opening                                                                   */
  /* ------------------------------------------------------------------------ */
  async function pickFiles() {
    if (MODE === "desktop") {
      const res = await desk.openFiles();
      return (res || []).map((f) => ({ name: f.name, bytes: f.bytes, path: f.path }));
    }
    if (MODE === "web") {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true });
      } catch (e) {
        if (e && e.name === "AbortError") return [];
        throw e;
      }
      return Promise.all(
        handles.map(async (h) => {
          const file = await h.getFile();
          return { name: h.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: h };
        })
      );
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = async () => {
        resolve(
          await Promise.all(
            Array.from(input.files).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))
          )
        );
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  async function findExisting(project, f) {
    if (f.path) return project.nodes.find((n) => n.diskPath === f.path) || null;
    if (f.handle) {
      for (const n of project.nodes) {
        const h = fileHandles.get(n.id);
        if (h && (await h.isSameEntry(f.handle))) return n;
      }
    }
    return null;
  }

  function link(node, f) {
    if (f.path) node.diskPath = f.path;
    if (f.handle) fileHandles.set(node.id, f.handle);
  }

  async function openFiles() {
    try {
      const picked = await pickFiles();
      if (!picked.length) return;
      if (!app.project) await app.newProject("blank", "Opened Files");
      const project = app.project;
      let last = null;
      for (const f of picked) {
        const d = decode(f.name, f.bytes);
        let node = await findExisting(project, f);
        if (node) {
          if (!GZ.tabs.isDirty(node.id)) applyDecoded(node, d);
        } else {
          node = P.createNode(project, null, "file", f.name, d.content);
          node.binary = d.binary;
          if (d.eol === "crlf") node.eol = "crlf";
          link(node, f);
        }
        last = node;
      }
      persistHandles();
      U.bus.emit("project:changed");
      GZ.explorer.render();
      app.persist();
      if (last) U.bus.emit("file:open", last.id);
      GZ.notify.ok(
        `Opened ${U.pluralize(picked.length, "file")}`,
        MODE === "none" ? "This browser can't save in place — Save will download." : "Ctrl+S saves straight back to the file."
      );
      updateStatus();
    } catch (e) {
      console.error(e);
      GZ.notify.error("Couldn't open file", e && e.message ? e.message : "Unknown error");
    }
  }

  async function walkDir(dir, prefix, state) {
    for await (const [name, h] of dir.entries()) {
      if (state.entries.length >= MAX_FILES) {
        state.skipped++;
        continue;
      }
      if (h.kind === "directory") {
        if (SKIP_DIRS.has(name)) continue;
        await walkDir(h, prefix + name + "/", state);
      } else {
        if (name === ".DS_Store") continue;
        const file = await h.getFile();
        if (file.size > MAX_BYTES) {
          state.skipped++;
          continue;
        }
        state.entries.push({ rel: prefix + name, bytes: new Uint8Array(await file.arrayBuffer()), handle: h });
      }
    }
    return state;
  }

  async function openFolder() {
    try {
      let entries = [];
      let skipped = 0;
      let root;

      if (MODE === "desktop") {
        const r = await desk.openFolder();
        if (!r) return;
        root = { name: r.name, path: r.root };
        entries = r.files.map((f) => ({ rel: f.rel, bytes: f.bytes, path: f.abs }));
        skipped = r.skipped || 0;
      } else if (MODE === "web") {
        let dir;
        try {
          dir = await window.showDirectoryPicker({ mode: "readwrite" });
        } catch (e) {
          if (e && e.name === "AbortError") return;
          throw e;
        }
        const busy = GZ.ui.busy("Reading folder…");
        try {
          const res = await walkDir(dir, "", { entries: [], skipped: 0 });
          entries = res.entries;
          skipped = res.skipped;
        } finally {
          busy.close();
        }
        root = { name: dir.name, handle: dir };
      } else {
        GZ.notify.warn("Folders need Chrome, Edge or the desktop app", "Use Open File instead in this browser.");
        return;
      }

      const project = P.createProject(root.name, P.TEMPLATES.blank);
      const folderIds = {};
      const ensureFolder = (path) => {
        if (!path) return null;
        if (folderIds[path]) return folderIds[path];
        const parts = path.split("/");
        const leaf = parts.pop();
        const parentId = ensureFolder(parts.join("/"));
        const node = P.createNode(project, parentId, "folder", leaf);
        folderIds[path] = node.id;
        return node.id;
      };

      let added = 0;
      for (const e of entries) {
        const parts = e.rel.split("/");
        const name = parts.pop();
        if (!U.isBinary(name) && hasNul(e.bytes)) {
          skipped++;
          continue;
        }
        const d = decode(name, e.bytes);
        const node = P.createNode(project, ensureFolder(parts.join("/")), "file", name, d.content);
        node.binary = d.binary;
        if (d.eol === "crlf") node.eol = "crlf";
        link(node, e);
        added++;
      }
      if (!added) {
        GZ.notify.warn("Nothing to open", "That folder has no files GazCode can edit.");
        return;
      }

      if (MODE === "desktop") project.diskRoot = root.path;
      else rootHandles.set(project.id, root.handle);

      app.projects.unshift(project);
      persistHandles();
      await app.persist();
      app.openProject(project.id);
      GZ.notify.ok(
        `Opened folder “${project.name}”`,
        `${U.pluralize(added, "file")}${skipped ? ` · ${skipped} skipped` : ""} · saves go straight to disk`
      );
    } catch (e) {
      console.error(e);
      GZ.notify.error("Couldn't open folder", e && e.message ? e.message : "Unknown error");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Reload / external change detection                                        */
  /* ------------------------------------------------------------------------ */
  async function readLinked(node, request) {
    try {
      if (MODE === "desktop" && node.diskPath) return await desk.readFile(node.diskPath);
      if (MODE === "web") {
        const h = fileHandles.get(node.id);
        if (!h || !(await perm(h, "read", !!request))) return null;
        return new Uint8Array(await (await h.getFile()).arrayBuffer());
      }
    } catch (e) {
      /* deleted / moved / unreadable */
    }
    return null;
  }

  async function reloadActive() {
    const node = app.activeNode();
    if (!node || !isLinked(node)) {
      GZ.notify.info("This file isn't linked to a file on disk");
      return;
    }
    if (GZ.tabs.isDirty(node.id)) {
      const ok = await GZ.ui.confirm({
        title: "Discard unsaved changes?",
        message: `“${node.name}” has edits that aren't saved. Reloading replaces them with the version on disk.`,
        confirmLabel: "Reload from disk",
        danger: true,
      });
      if (!ok) return;
    }
    const bytes = await readLinked(node, true);
    if (!bytes) {
      GZ.notify.warn("Couldn't read the file", "It may have been moved, deleted, or access was denied.");
      return;
    }
    applyDecoded(node, decode(node.name, bytes));
    app.persist();
    GZ.notify.ok("Reloaded from disk", node.name);
  }

  let checking = false;
  window.addEventListener("focus", async () => {
    if (checking || !app.project) return;
    const node = app.activeNode();
    if (!node || node.binary || !isLinked(node)) return;
    checking = true;
    try {
      const bytes = await readLinked(node, false);
      if (!bytes) return;
      const d = decode(node.name, bytes);
      if (d.content === node.content) return;
      if (GZ.tabs.isDirty(node.id)) {
        GZ.notify.warn("File changed on disk", `“${node.name}” also has unsaved edits here. Ctrl+S overwrites the disk version.`);
        return;
      }
      applyDecoded(node, d);
      app.persist();
      GZ.notify.info("Reloaded from disk", `“${node.name}” was changed outside GazCode.`);
    } finally {
      checking = false;
    }
  });

  /* Renaming/moving in the explorer breaks the link (the old file stays put). */
  U.bus.on("node:renamed", ({ id }) => {
    const node = app.project && P.getNode(app.project, id);
    if (node) {
      unlink(node);
      persistHandles();
      updateStatus();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* UI                                                                        */
  /* ------------------------------------------------------------------------ */
  function updateStatus() {
    let el = document.getElementById("stDisk");
    if (!el) {
      const git = document.getElementById("stGit");
      if (!git) return;
      el = document.createElement("span");
      el.id = "stDisk";
      el.className = "status-item hide-sm";
      git.parentNode.insertBefore(el, git);
    }
    const node = app.project && app.activeNode ? app.activeNode() : null;
    if (!node) {
      el.textContent = "";
      return;
    }
    if (isLinked(node)) {
      el.textContent = "● On disk";
      el.title = linkLabel(node);
      el.style.color = "var(--gold)";
    } else if (hasRoot(app.project)) {
      el.textContent = "● New file (saves into folder)";
      el.title = "";
      el.style.color = "";
    } else {
      el.textContent = "Browser only";
      el.title = "Use Save As (Ctrl+Shift+S) to put this file on your disk";
      el.style.color = "";
    }
  }

  const origStatus = app.refreshStatusBar;
  app.refreshStatusBar = function () {
    origStatus.call(this);
    updateStatus();
  };

  function openMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const auto = !!GZ.settings.values.autoSaveToDisk;
    GZ.ui.menu(
      [
        { group: "Disk" },
        { label: "Open File…", icon: "fileCode", kbd: "Ctrl+O", action: openFiles },
        { label: "Open Folder…", icon: "folderOpen", kbd: "Ctrl+Shift+O", action: openFolder },
        { sep: true },
        { label: "Save As…", icon: "save", kbd: "Ctrl+Shift+S", action: saveAsActive },
        { label: "Reload from Disk", icon: "refresh", action: reloadActive },
        { sep: true },
        {
          label: "Auto-save to disk",
          icon: auto ? "check" : "clock",
          action: toggleAuto,
        },
      ],
      { x: r.left, y: r.bottom + 6 }
    );
  }

  function toggleAuto() {
    const next = !GZ.settings.values.autoSaveToDisk;
    GZ.settings.set({ autoSaveToDisk: next });
    GZ.notify.ok(`Auto-save to disk ${next ? "on" : "off"}`, next ? "Linked files are written ~1s after you stop typing." : "Press Ctrl+S to write to disk.");
  }

  function injectUI() {
    const actions = document.querySelector(".topbar-actions");
    const saveBtn = document.getElementById("btnSave");
    if (actions && saveBtn && !document.getElementById("btnOpenDisk")) {
      actions.insertBefore(
        U.el("button.btn.btn-sm.desktop-only", {
          id: "btnOpenDisk",
          title: "Open from disk (Ctrl+O)",
          html: GZ.icons.get("folderOpen", 14) + "<span>Open</span>",
          onclick: openMenu,
        }),
        saveBtn
      );
    }

    const welcome = document.getElementById("welcomeActions");
    if (welcome && !document.getElementById("welcomeOpenFile")) {
      welcome.appendChild(
        U.el("button.btn", {
          id: "welcomeOpenFile",
          html: GZ.icons.get("fileCode", 14) + "<span>Open File…</span>",
          onclick: openFiles,
        })
      );
      welcome.appendChild(
        U.el("button.btn", {
          id: "welcomeOpenFolder",
          html: GZ.icons.get("folderOpen", 14) + "<span>Open Folder…</span>",
          onclick: openFolder,
        })
      );
    }

    const hero = document.querySelector("#dashboard .hero-actions");
    if (hero && !document.getElementById("dashOpenFolder")) {
      hero.appendChild(
        U.el("button.btn.btn-lg", {
          id: "dashOpenFolder",
          html: GZ.icons.get("folderOpen", 15) + "<span>Open Folder…</span>",
          onclick: () => {
            document.getElementById("dashboard").classList.remove("is-open");
            openFolder();
          },
        })
      );
    }
    updateStatus();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectUI);
  else injectUI();

  U.bus.on("tab:activate", updateStatus);
  U.bus.on("tabs:empty", updateStatus);

  GZ.palette.register([
    { id: "disk-open-file", title: "Open File from Disk…", icon: "fileCode", kbd: "Ctrl+O", group: "Commands", run: openFiles },
    { id: "disk-open-folder", title: "Open Folder from Disk…", icon: "folderOpen", kbd: "Ctrl+Shift+O", group: "Commands", run: openFolder },
    { id: "disk-save-as", title: "Save As…", icon: "save", kbd: "Ctrl+Shift+S", group: "Commands", run: saveAsActive },
    { id: "disk-reload", title: "Reload File from Disk", icon: "refresh", group: "Commands", run: reloadActive },
    { id: "disk-auto", title: "Toggle Auto-save to Disk", icon: "clock", group: "Commands", run: toggleAuto },
  ]);

  document.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        e.shiftKey ? openFolder() : openFiles();
      } else if (k === "s" && e.shiftKey) {
        e.preventDefault();
        saveAsActive();
      }
    },
    true
  );

  /* Warn before closing the tab if a file linked to disk has unsaved edits. */
  window.addEventListener("beforeunload", (e) => {
    if (!app.project) return;
    const risky = Array.from(GZ.tabs.dirty).some((id) => {
      const n = P.getNode(app.project, id);
      return n && isLinked(n);
    });
    if (risky) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  GZ.disk = { mode: MODE, openFiles, openFolder, saveAs: saveAsActive, reload: reloadActive, saveNode, isLinked };
})();
