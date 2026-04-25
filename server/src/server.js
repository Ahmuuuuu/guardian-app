const http = require('http');
const app = require('./app');
const { setupWebSocket } = require('../service/gateway/ws-gateway');
const accountService = require('../service/account/account-service');
const { getServerInt } = require('../utils/load-env');

const PORT = getServerInt('GUARDIAN_SERVER_PORT', 3847);
accountService.init();

const server = http.createServer(app);
setupWebSocket(server);

server.listen(PORT, 1024, () => {
  console.log(`Guardian server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/guardian-ws`);
  console.log('Default admin: admin / guardian2026');
});
