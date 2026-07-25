const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');

class ProxyManager extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.repoPath = path.join(userDataPath, 'free-claude-code');
    this.process = null;
    this.stats = {
      totalRequests: 0,
      errors: 0,
      activityLog: []
    };
  }

  init() {
    if (this._initPromise) return this._initPromise;
    
    this._initPromise = new Promise((resolve, reject) => {
      if (!fs.existsSync(this.repoPath)) {
        this.emit('log', { type: 'system', message: 'Cloning free-claude-code repository...' });
        const { exec } = require('child_process');
        exec('git clone https://github.com/Alishahryar1/free-claude-code.git', {
          cwd: path.dirname(this.repoPath)
        }, (error, stdout, stderr) => {
          if (error) {
            this.emit('log', { type: 'error', message: `Clone failed: ${error.message}` });
            this._initPromise = null; // allow retry
            reject(error);
          } else {
            this.emit('log', { type: 'system', message: 'Repository cloned successfully.' });
            resolve();
          }
        });
      } else {
        this.emit('log', { type: 'system', message: 'Repository already exists.' });
        resolve();
      }
    });
    return this._initPromise;
  }

  updateEnv(settings) {
    if (!fs.existsSync(this.repoPath)) return;
    const envPath = path.join(this.repoPath, '.env');
    let envContent = '';
    
    // Add API key
    if (settings.apiKey) {
      envContent += `NVIDIA_NIM_API_KEY="${settings.apiKey}"\n`;
    }
    
    // Auto-prefix logic
    const prefix = 'nvidia_nim/';
    const prefixModel = (model) => {
      if (!model) return '';
      return model.startsWith(prefix) ? model : `${prefix}${model}`;
    };

    if (settings.opus) envContent += `MODEL_OPUS="${prefixModel(settings.opus)}"\n`;
    if (settings.sonnet) envContent += `MODEL_SONNET="${prefixModel(settings.sonnet)}"\n`;
    if (settings.haiku) envContent += `MODEL_HAIKU="${prefixModel(settings.haiku)}"\n`;
    if (settings.fallback) envContent += `MODEL="${prefixModel(settings.fallback)}"\n`;

    fs.writeFileSync(envPath, envContent, 'utf8');
    this.emit('log', { type: 'system', message: '.env file updated with nvidia_nim/ prefixed models.' });
  }

  patchModelListing(settings) {
    if (!fs.existsSync(this.repoPath)) return;
    const providersDir = path.join(this.repoPath, 'providers');
    if (!fs.existsSync(providersDir)) {
      fs.mkdirSync(providersDir, { recursive: true });
    }

    // We only want the specific models without the prefix
    const modelsToReturn = [];
    if (settings.opus) modelsToReturn.push(settings.opus);
    if (settings.sonnet) modelsToReturn.push(settings.sonnet);
    if (settings.haiku) modelsToReturn.push(settings.haiku);
    if (settings.fallback) modelsToReturn.push(settings.fallback);
    
    // Unique models
    const uniqueModels = [...new Set(modelsToReturn)];

    const pyCode = `
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from providers.exceptions import ModelListResponseError

@dataclass(frozen=True, slots=True)
class ProviderModelInfo:
    model_id: str
    supports_thinking: bool | None = None

def extract_openai_model_ids(payload: Any, *, provider_name: str) -> frozenset[str]:
    # HARDCODED PATCH BY NVIDIA NIMS
    # Bypassing the dynamic fetch to prevent crashes from missing models on the upstream API
    return frozenset([
${uniqueModels.map(m => `        "${m}",`).join('\n')}
    ])

# We also leave the other functions stubbed to avoid breaking imports
def model_infos_from_ids(model_ids: Iterable[str], *, supports_thinking: bool | None = None) -> frozenset[ProviderModelInfo]:
    return frozenset(ProviderModelInfo(model_id=m, supports_thinking=supports_thinking) for m in model_ids)

def extract_openrouter_tool_model_ids(payload: Any, *, provider_name: str) -> frozenset[str]:
    return frozenset()

def extract_openrouter_tool_model_infos(payload: Any, *, provider_name: str) -> frozenset[ProviderModelInfo]:
    return frozenset()

def extract_ollama_model_ids(payload: Any, *, provider_name: str) -> frozenset[str]:
    return frozenset()
`;
    
    const patchPath = path.join(providersDir, 'model_listing.py');
    fs.writeFileSync(patchPath, pyCode.trim(), 'utf8');
    this.emit('log', { type: 'system', message: 'providers/model_listing.py patched to bypass model listing crash.' });
  }

  patchAppMiddleware() {
    const appPath = path.join(this.repoPath, 'api', 'app.py');
    if (!fs.existsSync(appPath)) return;
    
    let content = fs.readFileSync(appPath, 'utf8');
    
    if (!content.includes('__nims_stats')) {
      const originalMiddleware = `    @app.middleware("http")
    async def trace_http_correlation(request: Request, call_next):
        """Attach HTTP identifiers and optional Claude session id to logs."""
        claude_sid = extract_claude_session_id_from_headers(request.headers)
        with logger.contextualize(
            http_method=request.method,
            http_path=request.url.path,
            claude_session_id=claude_sid,
        ):
            response = await call_next(request)
        return response`;

      const patchedMiddleware = `    @app.middleware("http")
    async def trace_http_correlation(request: Request, call_next):
        import time, json
        start_time = time.time()
        claude_sid = extract_claude_session_id_from_headers(request.headers)
        with logger.contextualize(
            http_method=request.method,
            http_path=request.url.path,
            claude_session_id=claude_sid,
        ):
            response = await call_next(request)
        
        # NIMS PATCH: Inject stats metric
        print(json.dumps({
            "__nims_stats": True,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "latency_ms": (time.time() - start_time) * 1000
        }), flush=True)
        return response`;

      content = content.replace(originalMiddleware, patchedMiddleware);
      fs.writeFileSync(appPath, content, 'utf8');
      this.emit('log', { type: 'system', message: 'api/app.py patched for advanced stats tracking.' });
    }
  }

  start() {
    if (this.process) return;

    this.emit('log', { type: 'system', message: 'Starting uvicorn server via uv...' });
    
    // Kill any stale process holding port 8082 to prevent EADDRINUSE
    this._killPortHolder(8082);

    // Augment PATH for Finder launches
    const os = require('os');
    const customPath = [
      process.env.PATH,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(os.homedir(), '.cargo/bin'),
      path.join(os.homedir(), '.local/bin')
    ].join(':');

    // uv run automatically handles venv creation and dependency installation if uv.lock is present
    this.process = spawn('uv', ['run', 'uvicorn', 'server:app', '--host', '0.0.0.0', '--port', '8082'], {
      cwd: this.repoPath,
      env: { ...process.env, PATH: customPath },
      detached: true  // Create a new process group so we can kill the entire tree
    });
    // Don't let the child keep the parent alive
    this.process.unref();

    this.process.stdout.on('data', (data) => {
      const text = data.toString();
      this.emit('log', { type: 'stdout', message: text });
      this._parseStats(text);
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      this.emit('log', { type: 'stderr', message: text });
      
      if (text.includes('problem=missing model')) {
        // Extract model name using regex if possible, or just send a generic alert
        const match = text.match(/model=['"]?([^'"\s]+)['"]?/i);
        const modelName = match ? match[1] : 'Unknown Model';
        this.emit('missing-model', modelName);
      }
    });

    this.process.on('close', (code) => {
      this.emit('log', { type: 'system', message: `Server process exited with code ${code}` });
      this.process = null;
      this.emit('state-change', 'stopped');
    });

    this.emit('state-change', 'running');
  }

  stop() {
    if (!this.process) return;

    const pid = this.process.pid;
    this.emit('log', { type: 'system', message: `Stopping server (PID ${pid})...` });

    // 1. Try graceful SIGINT to the process group
    try {
      process.kill(-pid, 'SIGINT'); // negative PID = kill entire process group
    } catch (e) {
      try { this.process.kill('SIGINT'); } catch (e2) {}
    }

    // 2. After 2 seconds, force-kill the entire tree + clean the port
    setTimeout(() => {
      // Kill the spawned process if still alive
      if (this.process) {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
        try { this.process.kill('SIGKILL'); } catch (e) {}
      }
      // Belt-and-suspenders: kill anything still on port 8082
      this._killPortHolder(8082);
    }, 2000);
  }

  _killPortHolder(port) {
    try {
      // Find the PID holding the port using lsof
      const result = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
      if (result) {
        const pids = result.split('\n');
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid, 10), 'SIGKILL');
            this.emit('log', { type: 'system', message: `Killed stale process ${pid} on port ${port}` });
          } catch (e) {
            // process may have already exited
          }
        }
        // Small delay to let OS release the port
        execSync('sleep 0.5');
      }
    } catch (e) {
      // lsof returns exit code 1 when no process is found — that's fine
    }
  }

  _parseStats(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.includes('__nims_stats')) {
        try {
          // Extract the JSON object which might be mixed with text
          const start = line.indexOf('{');
          const end = line.lastIndexOf('}');
          if (start !== -1 && end !== -1) {
            const data = JSON.parse(line.substring(start, end + 1));
            if (data.__nims_stats) {
              this.stats.totalRequests++;
              if (data.status >= 400) this.stats.errors++;
              
              // Only update latency if it's a message request (where latency matters)
              if (data.path === '/v1/messages' && data.latency_ms) {
                 this.stats.avgLatency = this.stats.avgLatency || 0;
                 // Simple moving average
                 this.stats.avgLatency = (this.stats.avgLatency * 0.9) + (data.latency_ms * 0.1);
              }

              this.stats.activityLog.unshift(`[${new Date().toLocaleTimeString()}] ${data.method} ${data.path} - ${data.status} (${Math.round(data.latency_ms)}ms)`);
              if (this.stats.activityLog.length > 10) {
                this.stats.activityLog.pop();
              }
              this.emit('stats-update', this.stats);
            }
          }
        } catch (e) {
          // ignore parsing errors
        }
      } else if (line.includes('HTTP/1.1"') && !this.stats.avgLatency) {
        // Fallback for older logs if patch isn't applied yet
        this.stats.totalRequests++;
        const isError = line.includes('" 4') || line.includes('" 5');
        if (isError) this.stats.errors++;

        const match = line.match(/"(GET|POST|PUT|DELETE) (.*?) HTTP/);
        if (match) {
          const method = match[1];
          const path = match[2];
          const statusMatch = line.match(/HTTP\/1\.1" (\d{3})/);
          const status = statusMatch ? statusMatch[1] : 'UNK';
          
          this.stats.activityLog.unshift(`[${new Date().toLocaleTimeString()}] ${method} ${path} - ${status}`);
          if (this.stats.activityLog.length > 10) {
            this.stats.activityLog.pop();
          }
        }
        this.emit('stats-update', this.stats);
      }
    }
  }
}

module.exports = ProxyManager;
