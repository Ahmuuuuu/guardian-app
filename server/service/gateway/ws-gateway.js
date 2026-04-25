const { WebSocketServer } = require('ws');
const stateService = require('../runtime/runtime-state-service');
const { createConnectionLimiter } = require('./connection-limiter');
const { getServerInt, getServerBool } = require('../../utils/load-env');

const WS_PATH = '/guardian-ws';

function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });
  const limiter = createConnectionLimiter({
    wss,
    path: WS_PATH,
    maxConcurrent: getServerInt('WS_ADMISSION_MAX_CONCURRENT', 100),
    perSec: getServerInt('WS_ADMISSION_PER_SEC', 200),
    maxQueue: getServerInt('WS_ADMISSION_MAX_QUEUE', 500),
    maxPerIp: getServerInt('WS_ADMISSION_MAX_PER_IP', 20),
    retryAfterSec: getServerInt('WS_ADMISSION_RETRY_AFTER_SEC', 2),
    queueTimeoutMs: getServerInt('WS_ADMISSION_QUEUE_TIMEOUT_MS', 10000),
    allowLoopbackBypass: getServerBool('WS_ADMISSION_LOOPBACK_BYPASS', true)
  });

  server.on('upgrade', limiter.handleUpgrade);

  wss.on('connection', async (ws, req) => {
    const ip = String(req.socket.remoteAddress || '').replace('::ffff:', '');
    const client = await stateService.createClient(ws, ip);

    ws.send(JSON.stringify({ type: 'welcome', clientId: client.clientId }));

    const bindTimeout = setTimeout(async () => {
      const current = await stateService.getClient(client.clientId);
      if (current && !current.roomId) {
        ws.close(4000, 'bind timeout');
      }
    }, 30000);

    ws.on('message', async raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      await stateService.touchClient(client.clientId);

      switch (msg.type) {
        case 'bind': {
          const joinCode = msg.roomCode || msg.joinCode;
          const room = await stateService.findRoomByJoinCode(joinCode);
          if (!room) {
            ws.send(JSON.stringify({ type: 'bind-ack', ok: false, msg: '房间码无效' }));
            return;
          }

          const student = await stateService.findStudentInRoom(room, msg.studentId);
          if (!student) {
            ws.send(JSON.stringify({ type: 'bind-ack', ok: false, msg: '该学号未在本房间注册' }));
            return;
          }

          await stateService.bindClient(client.clientId, {
            roomId: room.id,
            studentId: student.studentId,
            studentName: msg.name || student.name,
            hostname: msg.hostname || ''
          });

          ws.send(JSON.stringify({
            type: 'bind-ack',
            ok: true,
            roomId: room.id,
            roomName: room.roomName
          }));
          break;
        }

        case 'heartbeat':
          await stateService.updateClientHeartbeat(client.clientId, msg);
          ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
          break;

        case 'violation-log':
          await stateService.appendClientViolations(client.clientId, msg.violations || []);
          break;

        default:
          break;
      }
    });

    ws.on('close', async () => {
      clearTimeout(bindTimeout);
      await stateService.deleteClient(client.clientId);
    });

    ws.on('error', async () => {
      clearTimeout(bindTimeout);
      await stateService.deleteClient(client.clientId);
    });
  });

  const pruneTimer = setInterval(async () => {
    await stateService.pruneInactiveClients(120000);
  }, 30000);

  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  const onServerClose = () => {
    limiter.close();
  };
  server.once('close', onServerClose);

  return {
    close: () => {
      clearInterval(pruneTimer);
      server.removeListener('upgrade', limiter.handleUpgrade);
      server.removeListener('close', onServerClose);
      limiter.close();
      try {
        wss.close();
      } catch (_) {
        // ignore close error
      }
    }
  };
}

module.exports = { setupWebSocket };
