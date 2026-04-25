const fs = require('fs');
const path = require('path');

let loaded = false;
let loadedFiles = [];
let loadedValues = {};

function stripQuotes(value) {
  if (!value) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex <= 0) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(eqIndex + 1).trim();
  value = stripQuotes(value);
  return { key, value };
}

function applyEnvFile(filePath, options = {}) {
  const override = options.override === true;
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const item = parseLine(line);
    if (!item) continue;
    if (override || loadedValues[item.key] === undefined) {
      loadedValues[item.key] = item.value;
    }
  }

  return true;
}

function loadServerEnv() {
  if (loaded) {
    return {
      files: loadedFiles.slice(),
      values: { ...loadedValues }
    };
  }

  const serverRoot = path.join(__dirname, '..');
  const baseFile = path.join(serverRoot, '.env');
  if (applyEnvFile(baseFile, { override: false })) {
    loadedFiles.push(baseFile);
  }

  const envName = String(process.env.NODE_ENV || loadedValues.NODE_ENV || '').trim();
  if (envName) {
    const modeFile = path.join(serverRoot, `.env.${envName}`);
    if (applyEnvFile(modeFile, { override: true })) {
      loadedFiles.push(modeFile);
    }
  }

  loaded = true;
  return {
    files: loadedFiles.slice(),
    values: { ...loadedValues }
  };
}

function getServerEnv(name, fallback) {
  loadServerEnv();
  const key = String(name || '').trim();
  if (!key) return fallback;
  const value = loadedValues[key];
  return value === undefined ? fallback : value;
}

function getServerInt(name, fallback) {
  const raw = getServerEnv(name, undefined);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function getServerBool(name, fallback) {
  const raw = getServerEnv(name, undefined);
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

module.exports = {
  loadServerEnv,
  getServerEnv,
  getServerInt,
  getServerBool
};
