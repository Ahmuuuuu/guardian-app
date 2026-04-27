/**
 * remote-client.js — 子机端 WebSocket 客户端
 * 连接到管控服务器，上报状态，接收管控指令
 *
 * 使用方法：
 *   const remote = require('./remote-client');
 *   remote.connect('ws://教师机IP:3847/guardian-ws');
 *   remote.on('command', (cmd) => { ... });
 *   remote.on('message', (msg) => { showToast(msg); });
 */

const { WebSocket } = require('ws');
const os = require('os');
const crypto = require('crypto');
const iconvLite = require('iconv-lite');

let ws = null;
let clientId = null;
let studentId = null;       // 绑定后设置
let studentName = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let serverUrl = '';
let _guardStatus = false;
let _processCount = 0;
let _violations = [];

const listeners = { command: [], message: [], connect: [], disconnect: [] };

// ---------- 工具函数：确保中文正确输出 ----------
function safeLog(prefix, ...args) {
  const messages = args.map(arg => {
    if (typeof arg === 'string') {
      return arg;
    }
    try {
      return JSON.stringify(arg);
    } catch (e) {
      return String(arg);
    }
  });
  console.log(prefix, ...messages);
}

// ---------- 事件 ----------
function on(evt, cb) { if (listeners[evt]) listeners[evt].push(cb); }
function emit(evt, data) { (listeners[evt] || []).forEach(cb => cb(data)); }

// ---------- 连接 ----------
function connect(url) {
  serverUrl = url;
  _doConnect();
}

function _doConnect() {
  if (ws && ws.readyState < 2) return; // 正在连接或已连接
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  safeLog('[Remote] 连接管控服务器:', serverUrl);
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    console.error('[Remote] WebSocket 创建失败:', e.message);
    _scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    safeLog('[Remote] 已连接管控服务器');
    emit('connect');
    // 发送绑定信息
    send({ type: 'bind', studentId, hostname: os.hostname() });
    // 启动心跳
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'heartbeat',
          guardActive: _guardStatus,
          processCount: _processCount,
          violations: _violations.slice(0, 10)
        }));
      }
    }, 5000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    safeLog('[Remote] 收到消息:', msg.type);

    switch (msg.type) {
      case 'welcome':
        clientId = msg.clientId;
        safeLog('[Remote] 获得 clientId:', clientId);
        break;

      case 'heartbeat-ack':
        // 心跳确认，无需处理
        break;

      case 'toggle-guard':
        emit('command', { action: 'toggle-guard', enabled: msg.enabled });
        break;

      case 'update-whitelist':
        emit('command', { action: 'update-whitelist', whitelist: msg.whitelist });
        break;

      case 'force-kill-process':
        emit('command', { action: 'kill-process', pid: msg.pid });
        break;

      case 'broadcast':
        emit('message', msg.message || '收到管控消息');
        break;

      default:
        safeLog('[Remote] 未知消息类型:', msg.type);
    }
  });

  ws.on('close', () => {
    safeLog('[Remote] 连接断开');
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    emit('disconnect');
    _scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Remote] WebSocket 错误:', err.message);
  });
}

// ---------- 重连 ----------
function _scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    safeLog('[Remote] 尝试重新连接...');
    _doConnect();
  }, 5000);
}

// ---------- 发送 ----------
function send(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ---------- 状态更新（由 main.js 调用） ----------
function updateStatus({ guardActive, processCount, violations }) {
  _guardStatus = guardActive;
  _processCount = processCount;
  if (violations) _violations = violations;
}

// ---------- 绑定学生身份 ----------
function bindStudent(sid, name) {
  studentId = sid;
  studentName = name;
  if (ws && ws.readyState === 1) {
    send({ type: 'bind', studentId: sid, hostname: os.hostname() });
  }
}

// ---------- 断开 ----------
function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (ws) { ws.close(); ws = null; }
}

function isConnected() {
  return ws && ws.readyState === 1;
}

module.exports = { connect, disconnect, send, bindStudent, updateStatus, on, isConnected };
