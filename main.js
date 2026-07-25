const { app, BrowserWindow, Tray, ipcMain, dialog, nativeTheme, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Log to user data path for debugging
let logStream = null;
try {
  const logDir = app.getPath('userData');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFile = path.join(logDir, 'app_debug.log');
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  console.log = function(...args) {
    logStream.write(`[LOG] ${new Date().toISOString()} - ${args.join(' ')}\n`);
  };
  console.error = function(...args) {
    logStream.write(`[ERR] ${new Date().toISOString()} - ${args.join(' ')}\n`);
  };
} catch (e) {
  // Fallback if app is not fully initialized
}


const ProxyManager = require('./backend');

let tray = null;
let trayWindow = null;
let settingsWindow = null;
let logsWindow = null;
let dashboardWindow = null;
let walkthroughWindow = null;
let proxyManager = null;

// Ensure single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Focus or open our main window
    if (config.apiKey) {
      openWindow('dashboard');
    } else {
      openWindow('settings');
    }
  });
}


const configPath = path.join(app.getPath('userData'), 'nims-config.json');
let config = { apiKey: '', opus: '', sonnet: '', haiku: '', fallback: '', onboardingComplete: false };

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  console.error('Failed to read config', e);
}

function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function createTray() {
  const iconPath = path.join(process.resourcesPath, 'trayIconTemplate.png');
  console.log("createTray: Loading icon from: " + iconPath);
  
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    image.setTemplateImage(true);
    console.log("createTray: Loaded icon image - empty: " + image.isEmpty());
  } catch (e) {
    console.error("createTray: Error loading icon image", e);
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image, 'E890835D-BAA3-41E9-9C5B-1A05872A7C32');
  tray.setToolTip('Nvidia NIMS Server');

  const { screen } = require('electron');
  console.log("createTray: Primary Display: " + JSON.stringify(screen.getPrimaryDisplay().bounds));
  console.log("createTray: All Displays: " + JSON.stringify(screen.getAllDisplays().map(d => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor
  }))));

  setTimeout(() => {
    try {
      console.log("createTray: Delayed Tray bounds check: " + JSON.stringify(tray.getBounds()));
    } catch (err) {
      console.error("createTray: Error fetching tray bounds", err);
    }
  }, 2000);

  tray.on('click', (event, bounds) => {
    toggleTrayWindow(bounds);
  });
}

function updateTrayStatus(state) {
  if (!tray) return;
  try {
    const iconName = state === 'running' ? 'trayIconActive.png' : 'trayIconTemplate.png';
    const iconPath = path.join(process.resourcesPath, iconName);
    console.log("updateTrayStatus: Swapping icon directly with path string: " + iconPath);
    const img = nativeImage.createFromPath(iconPath);
    if (state !== 'running') {
      img.setTemplateImage(true);
    }
    tray.setImage(img);
    tray.setTitle('');
    tray.setToolTip(state === 'running' ? 'Nvidia NIMS — Running' : 'Nvidia NIMS — Stopped');
  } catch (err) {
    console.error("updateTrayStatus: Error updating tray icon", err);
  }
}

function createTrayWindow() {
  trayWindow = new BrowserWindow({
    width: 300,
    height: 360,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  
  trayWindow.loadFile(path.join(__dirname, 'index.html'));
  
  trayWindow.on('blur', () => {
    trayWindow.hide();
  });
}

function toggleTrayWindow(bounds) {
  if (trayWindow.isVisible()) {
    trayWindow.hide();
  } else {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const screenWidth = display.bounds.width;
    const screenHeight = display.bounds.height;
    
    // Position below tray (fallback to top right if bounds empty/invalid)
    const safeBounds = bounds && bounds.width && bounds.height ? bounds : { x: screenWidth - 200, y: 0, width: 40, height: 22 };
    
    const winBounds = trayWindow.getBounds();
    
    console.log("toggleTrayWindow: Original bounds Y: " + safeBounds.y + ", Screen Height: " + screenHeight);
    
    let trayY = safeBounds.y;
    // Map Cocoa coordinates (origin bottom-left, y goes up) to Electron coordinates (origin top-left, y goes down)
    if (trayY > screenHeight / 2) {
      trayY = screenHeight - trayY - safeBounds.height;
      console.log("toggleTrayWindow: Detected Cocoa coordinates. Converted Y to: " + trayY);
    }
    
    const posX = Math.round(safeBounds.x + (safeBounds.width / 2) - (winBounds.width / 2));
    const posY = trayY + safeBounds.height + 5;
    
    console.log("toggleTrayWindow: Final positioning coordinate X: " + posX + ", Y: " + posY);
    
    trayWindow.setPosition(posX, posY, false);
    trayWindow.show();
    trayWindow.focus();
  }
}

function openWindow(type) {
  console.log("openWindow called for type:", type);
  if (trayWindow) trayWindow.hide(); // Hide tray menu when opening a window

  app.focus({ steal: true }); // Bring app to front

  let win = null;
  const commonOptions = {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    },
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset'
  };

  const handleClosed = () => {
    // No-op
  };

  const attachLoadErrorListener = (w, name) => {
    w.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error(`Failed to load ${name} window:`, errorDescription, `Code: ${errorCode}`);
    });
  };

  if (type === 'walkthrough') {
    if (walkthroughWindow) return walkthroughWindow.focus();
    win = new BrowserWindow({ ...commonOptions, width: 800, height: 600, title: 'Welcome', show: false });
    attachLoadErrorListener(win, 'walkthrough');
    win.loadFile(path.join(__dirname, 'walkthrough.html'));
    walkthroughWindow = win;
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      app.focus({ steal: true });
    });
    win.on('closed', () => { walkthroughWindow = null; handleClosed(); });
  }
  else if (type === 'settings') {
    if (settingsWindow) return settingsWindow.focus();
    win = new BrowserWindow({ ...commonOptions, width: 520, height: 720, title: 'Settings', show: false });
    attachLoadErrorListener(win, 'settings');
    win.loadFile(path.join(__dirname, 'settings.html'));
    settingsWindow = win;
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      app.focus({ steal: true });
    });
    win.on('closed', () => { settingsWindow = null; handleClosed(); });
  } 
  else if (type === 'logs') {
    if (logsWindow) return logsWindow.focus();
    win = new BrowserWindow({ ...commonOptions, width: 800, height: 500, title: 'Server Logs', show: false });
    attachLoadErrorListener(win, 'logs');
    win.loadFile(path.join(__dirname, 'logs.html'));
    logsWindow = win;
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      app.focus({ steal: true });
    });
    win.on('closed', () => { logsWindow = null; handleClosed(); });
  }
  else if (type === 'dashboard') {
    if (dashboardWindow) return dashboardWindow.focus();
    win = new BrowserWindow({ ...commonOptions, width: 700, height: 500, title: 'Stats Dashboard', show: false });
    attachLoadErrorListener(win, 'dashboard');
    win.loadFile(path.join(__dirname, 'dashboard.html'));
    dashboardWindow = win;
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      app.focus({ steal: true });
    });
    win.on('closed', () => { dashboardWindow = null; handleClosed(); });
  }
}

app.whenReady().then(async () => {
  console.log("=== APP BOOT ===");
  console.log("process.execPath: " + process.execPath);
  console.log("process.argv: " + JSON.stringify(process.argv));
  console.log("app.getPath('exe'): " + app.getPath('exe'));
  console.log("App ready event fired");
  createTray();
  createTrayWindow();

  // Register global shortcut to toggle tray popup (Ctrl+Shift+N)
  // This ensures the app is accessible even if the menu bar icon is hidden
  globalShortcut.register('Control+Shift+N', () => {
    if (trayWindow && trayWindow.isVisible()) {
      trayWindow.hide();
    } else if (tray) {
      const bounds = tray.getBounds();
      // If tray is in overflow (y > 100), show popup at top-right of screen
      if (bounds.y > 100) {
        const { screen } = require('electron');
        const display = screen.getPrimaryDisplay();
        const { width: screenWidth } = display.workAreaSize;
        toggleTrayWindow({ x: screenWidth - 200, y: 0, width: 40, height: 24 });
      } else {
        toggleTrayWindow(bounds);
      }
    }
  });
  
  proxyManager = new ProxyManager(app.getPath('userData'));
  console.log("ProxyManager initialized, user data path:", app.getPath('userData'));
  
  proxyManager.on('log', (log) => {
    if (logsWindow) logsWindow.webContents.send('log-stream', log);
    if (walkthroughWindow) walkthroughWindow.webContents.send('log-stream', log);
  });

  proxyManager.on('state-change', (state) => {
    if (trayWindow) trayWindow.webContents.send('state-change', state);
    if (settingsWindow) settingsWindow.webContents.send('state-change', state);
    
    // Update Tray status indicator
    updateTrayStatus(state);
  });

  proxyManager.on('stats-update', (stats) => {
    if (dashboardWindow) dashboardWindow.webContents.send('stats-update', stats);
  });

  proxyManager.on('missing-model', (modelName) => {
    dialog.showErrorBox(
      'Server Crashed',
      `The model "${modelName}" is missing or no longer available. Please update it in Settings.`
    );
  });

  try {
    if (!config.onboardingComplete) {
      console.log("Onboarding not complete, opening walkthrough");
      openWindow('walkthrough');
      // init in background so Walkthrough opens instantly
      proxyManager.init()
        .then(() => {
          console.log("Background init complete");
          if (walkthroughWindow) walkthroughWindow.webContents.send('init-complete');
        })
        .catch(err => {
          console.error("Background init error:", err);
          if (walkthroughWindow) walkthroughWindow.webContents.send('init-error', err.message);
        });
    } else {
      console.log("Onboarding complete, running init");
      await proxyManager.init();
      console.log("proxyManager init done, config apiKey present:", !!config.apiKey);
      if (config.apiKey) {
        proxyManager.updateEnv(config);
        proxyManager.patchModelListing(config);
        proxyManager.patchAppMiddleware();
        console.log("Starting proxy server...");
        proxyManager.start();
        console.log("Opening dashboard window...");
        openWindow('dashboard');
      } else {
        openWindow('settings');
      }
    }
  } catch (err) {
    console.error("Initialization Error:", err);
    dialog.showErrorBox('Initialization Error', err.message);
  }
});

// Reopen dashboard when Dock icon is clicked (standard macOS behavior)
app.on('activate', () => {
  if (config.apiKey) {
    openWindow('dashboard');
  } else {
    openWindow('settings');
  }
});

app.on('window-all-closed', () => {});

ipcMain.handle('get-config', () => config);

ipcMain.handle('save-config', async (event, newConfig) => {
  saveConfig(newConfig);
  try {
    await proxyManager.init(); // ensure repo exists before patching
    proxyManager.updateEnv(config);
    proxyManager.patchModelListing(config);
    proxyManager.patchAppMiddleware();
    
    if (proxyManager.process) {
      // Wait for the process to actually die before restarting
      await new Promise((resolve) => {
        proxyManager.once('state-change', () => resolve());
        proxyManager.stop();
        // Safety timeout in case the event never fires
        setTimeout(resolve, 3000);
      });
      // Extra pause to let the OS fully release the port
      await new Promise(r => setTimeout(r, 500));
    }
    proxyManager.start();
  } catch (err) {
    console.error("save-config init/start error:", err);
  }
  return true;
});

ipcMain.handle('get-stats', () => proxyManager.stats);

ipcMain.handle('fetch-models', async (event, passedApiKey) => {
  const apiKey = passedApiKey || config.apiKey;
  if (!apiKey) return { error: 'No API key configured' };
  
  try {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.request('https://integrate.api.nvidia.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const models = (json.data || []).map(m => m.id).sort();
            resolve({ models });
          } catch (e) {
            resolve({ error: 'Failed to parse response from NVIDIA API' });
          }
        });
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ error: 'Request timed out connecting to NVIDIA API' });
      });
      req.end();
    });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('set-login-settings', (event, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable
  });
  return true;
});

ipcMain.handle('get-login-settings', () => {
  return app.getLoginItemSettings();
});

ipcMain.on('close-walkthrough', () => {
  if (walkthroughWindow) {
    walkthroughWindow.close();
    walkthroughWindow = null;
  }
  openWindow('dashboard');
});

ipcMain.on('toggle-server', () => {
  if (proxyManager.process) {
    proxyManager.stop();
  } else {
    proxyManager.start();
  }
});

ipcMain.on('open-window', (event, type) => {
  openWindow(type);
});

ipcMain.on('open-external', (event, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

ipcMain.on('quit-app', () => {
  if (proxyManager) proxyManager.stop();
  app.quit();
});
