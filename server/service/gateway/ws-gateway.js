const { WebSocketServer, WebSocket } = require('ws');
const stateService = require('../runtime/runtime-state-service');
const { createConnectionLimiter } = require('./connection-limiter');
const { getServerInt, getServerBool } = require('../../utils/load-env');

const WS_PATH = '/guardian-ws';

function safeSend(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
  } catch (error) {
    console.log('ws send err');
    console.log(error);
  }

  return false;
}

function safeClose(ws, code, reason) {
  try {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close(code, reason);
    }
  } catch (error) {
    console.log('ws close err');
    console.log(error);
  }
}

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

  wss.on('connection', (ws, req) => {
    handleConnection(ws, req).catch(error => {
      console.log('connection handler err');
      console.log(error);

      safeClose(ws, 1011, 'internal error');
    });
  });

  const pruneTimer = setInterval(async () => {
    try {
      await stateService.pruneInactiveClients(120000);
    } catch (error) {
      console.log('prune inactive clients err');
      console.log(error);
    }
  }, 30000);

  if (typeof pruneTimer.unref === 'function') {
    pruneTimer.unref();
  }

  const onServerClose = () => {
    limiter.close();
  };

  server.once('close', onServerClose);

  async function handleConnection(ws, req) {
    let ip = '';
    let client = null;
    let cleaned = false;
    let bindTimeout = null;

    async function cleanup(reason) {
      if (cleaned) return;
      cleaned = true;

      try {
        if (bindTimeout) {
          clearTimeout(bindTimeout);
          bindTimeout = null;
        }

        if (client && client.clientId) {
          await stateService.deleteClient(client.clientId);
        }
      } catch (error) {
        console.log(`${reason} cleanup err`);
        console.log(error);
      }
    }

    try {
      ip = String(req.socket.remoteAddress || '').replace('::ffff:', '');
      client = await stateService.createClient(ws, ip);
    } catch (error) {
      console.log('client create err');
      console.log(error);

      safeClose(ws, 1011, 'client create failed');
      return;
    }

    safeSend(ws, {
      type: 'welcome',
      clientId: client.clientId
    });

    bindTimeout = setTimeout(async () => {
      try {
        if (!client || !client.clientId) return;

        const current = await stateService.getClient(client.clientId);

        if (current && !current.roomId) {
          safeClose(ws, 4000, 'bind timeout');
        }
      } catch (error) {
        console.log('bind timeout err');
        console.log(error);
      }
    }, 30000);

    ws.on('message', async raw => {
      let msg;

      try {
        msg = JSON.parse(raw.toString());

        if (!client || !client.clientId) {
          safeClose(ws, 1011, 'client missing');
          return;
        }

        await stateService.touchClient(client.clientId);
      } catch (error) {
        console.log('message parse/touch err');
        console.log(error);
        return;
      }

      switch (msg.type) {
        case 'bind': {
          try {
            const joinCode = msg.roomCode || msg.joinCode;

            const room = await stateService.findRoomByJoinCode(joinCode);

            if (!room) {
              safeSend(ws, {
                type: 'bind-ack',
                ok: false,
                msg: '房间码无效'
              });
              return;
            }

            const student = await stateService.findStudentInRoom(
              room,
              msg.studentId
            );

            if (!student) {
              safeSend(ws, {
                type: 'bind-ack',
                ok: false,
                msg: '该学号未在本房间注册'
              });
              return;
            }

            await stateService.bindClient(client.clientId, {
              roomId: room.id,
              studentId: student.studentId,
              studentName: msg.name || student.name,
              hostname: msg.hostname || ''
            });

            safeSend(ws, {
              type: 'bind-ack',
              ok: true,
              roomId: room.id,
              roomName: room.roomName
            });
          } catch (error) {
            console.log('bind err');
            console.log(error);

            safeSend(ws, {
              type: 'bind-ack',
              ok: false,
              msg: '绑定失败，请稍后重试'
            });
          }

          break;
        }

        case 'heartbeat': {
          try {
            await stateService.updateClientHeartbeat(client.clientId, msg);

            safeSend(ws, {
              type: 'heartbeat-ack'
            });
          } catch (error) {
            console.log('heartbeat err');
            console.log(error);
          }

          break;
        }

        case 'violation-log': {
          try {
            await stateService.appendClientViolations(
              client.clientId,
              msg.violations || []
            );
          } catch (error) {
            console.log('violation-log err');
            console.log(error);
          }

          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      cleanup('close');
    });

    ws.on('error', error => {
      console.log('ws error');
      console.log(error);

      cleanup('error');
    });
  }

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