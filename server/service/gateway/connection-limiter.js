function normalizeIp(rawIp) {
  return String(rawIp || '').replace('::ffff:', '');
}

function getPathname(urlValue) {
  const url = String(urlValue || '');
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function destroySocket(socket) {
  if (!socket || socket.destroyed) return;
  try {
    socket.destroy();
  } catch (_) {
    // ignore socket close error
  }
}

function rejectUpgrade(socket, statusCode, statusText, retryAfter, reason) {
  if (!socket || socket.destroyed) return;

  const headers = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8'
  ];

  if (retryAfter !== undefined && retryAfter !== null) {
    headers.push(`Retry-After: ${retryAfter}`);
  }
  if (reason) {
    headers.push(`X-Guardian-Admission: ${reason}`);
  }

  const body = reason ? `gateway-${reason}\n` : 'gateway-rejected\n';

  try {
    socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
  } catch (_) {
    // ignore write error
  }
  destroySocket(socket);
}

function createConnectionLimiter(options = {}) {
  const wss = options.wss;
  const path = options.path || '/guardian-ws';
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 100);
  const perSec = Math.max(1, Number(options.perSec) || 200);
  const maxQueue = Math.max(0, Number(options.maxQueue) || 500);
  const maxPerIp = Math.max(0, Number(options.maxPerIp) || 20);
  const retryAfterSec = Math.max(1, Number(options.retryAfterSec) || 2);
  const queueTimeoutMs = Math.max(1000, Number(options.queueTimeoutMs) || 10000);
  const allowLoopbackBypass = options.allowLoopbackBypass !== false;

  if (!wss || typeof wss.handleUpgrade !== 'function') {
    throw new Error('createConnectionLimiter requires a WebSocketServer instance');
  }

  const pendingByIp = new Map();
  const queue = [];
  const bucketCapacity = perSec;
  const refillIntervalMs = 100;
  const tokensPerTick = perSec * (refillIntervalMs / 1000);

  let tokens = bucketCapacity;
  let inFlight = 0;
  let closed = false;

  function getPending(ip) {
    return pendingByIp.get(ip) || 0;
  }

  function holdPending(ip) {
    pendingByIp.set(ip, getPending(ip) + 1);
  }

  function releasePending(ip) {
    const current = getPending(ip);
    if (current <= 1) {
      pendingByIp.delete(ip);
      return;
    }
    pendingByIp.set(ip, current - 1);
  }

  function canAdmitNow() {
    return tokens >= 1 && inFlight < maxConcurrent;
  }

  function getIpLimit(ip) {
    if (maxPerIp <= 0) return Infinity;
    if (allowLoopbackBypass && isLoopbackIp(ip)) return Infinity;
    return maxPerIp;
  }

  function tryAdmit(entry) {
    if (!entry) return false;
    if (entry.socket.destroyed) {
      releasePending(entry.ip);
      return false;
    }
    if (!canAdmitNow()) {
      return false;
    }

    tokens = Math.max(0, tokens - 1);
    inFlight += 1;

    try {
      wss.handleUpgrade(entry.req, entry.socket, entry.head, ws => {
        inFlight = Math.max(0, inFlight - 1);
        releasePending(entry.ip);
        wss.emit('connection', ws, entry.req);
        drainQueue();
      });
      return true;
    } catch (_) {
      inFlight = Math.max(0, inFlight - 1);
      releasePending(entry.ip);
      destroySocket(entry.socket);
      return false;
    }
  }

  function rejectQueuedEntry(entry, reason) {
    if (!entry) return;
    releasePending(entry.ip);
    rejectUpgrade(entry.socket, 503, 'Service Unavailable', retryAfterSec, reason);
  }

  function drainQueue() {
    if (closed) return;

    while (queue.length > 0 && canAdmitNow()) {
      const entry = queue.shift();
      if (!entry) continue;
      if (entry.socket.destroyed) {
        releasePending(entry.ip);
        continue;
      }
      if (Date.now() - entry.enqueuedAt > queueTimeoutMs) {
        rejectQueuedEntry(entry, 'queue-timeout');
        continue;
      }
      if (!tryAdmit(entry)) {
        queue.unshift(entry);
        break;
      }
    }
  }

  function enqueue(entry) {
    if (queue.length >= maxQueue) {
      rejectQueuedEntry(entry, 'queue-full');
      return false;
    }
    queue.push(entry);
    return true;
  }

  function handleUpgrade(req, socket, head) {
    if (closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable', retryAfterSec, 'gateway-closing');
      return;
    }

    const pathname = getPathname(req.url);
    if (pathname !== path) {
      rejectUpgrade(socket, 404, 'Not Found', null, 'bad-path');
      return;
    }

    const ip = normalizeIp(req.socket && req.socket.remoteAddress);
    if (getPending(ip) >= getIpLimit(ip)) {
      rejectUpgrade(socket, 503, 'Service Unavailable', retryAfterSec, 'ip-limit');
      return;
    }

    holdPending(ip);
    const entry = {
      req,
      socket,
      head,
      ip,
      enqueuedAt: Date.now()
    };

    if (tryAdmit(entry)) {
      return;
    }
    if (!enqueue(entry)) {
      return;
    }
    drainQueue();
  }

  const refillTimer = setInterval(() => {
    if (closed) return;
    tokens = Math.min(bucketCapacity, tokens + tokensPerTick);
    drainQueue();
  }, refillIntervalMs);

  const drainTimer = setInterval(() => {
    if (!closed) {
      drainQueue();
    }
  }, 5);

  if (typeof refillTimer.unref === 'function') refillTimer.unref();
  if (typeof drainTimer.unref === 'function') drainTimer.unref();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(refillTimer);
    clearInterval(drainTimer);
    while (queue.length > 0) {
      rejectQueuedEntry(queue.shift(), 'gateway-closing');
    }
  }

  function getStats() {
    return {
      inFlight,
      queueLength: queue.length,
      tokens: Number(tokens.toFixed(2)),
      perSec,
      maxConcurrent,
      maxQueue,
      maxPerIp
    };
  }

  return {
    handleUpgrade,
    close,
    getStats
  };
}

module.exports = { createConnectionLimiter };
