const MEMORY_STATE_KEY = Symbol.for('guardian.memory.state');

function createMemoryState() {
  return {
    rooms: new Map(),
    roomCodeIndex: new Map(),
    clients: new Map(),
    clientRoomIndex: new Map()
  };
}

function getMemoryState() {
  if (!globalThis[MEMORY_STATE_KEY]) {
    globalThis[MEMORY_STATE_KEY] = createMemoryState();
  }
  return globalThis[MEMORY_STATE_KEY];
}

const state = getMemoryState();

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function getRoom(roomId) {
  return state.rooms.get(roomId) || null;
}

function setRoom(room) {
  state.rooms.set(room.id, room);
}

function deleteRoom(roomId) {
  state.rooms.delete(roomId);
}

function listRooms() {
  return Array.from(state.rooms.values());
}

function getRoomIdByJoinCode(code) {
  return state.roomCodeIndex.get(normalizeCode(code)) || null;
}

function hasJoinCode(code) {
  return state.roomCodeIndex.has(normalizeCode(code));
}

function setJoinCode(code, roomId) {
  state.roomCodeIndex.set(normalizeCode(code), roomId);
}

function deleteJoinCode(code) {
  state.roomCodeIndex.delete(normalizeCode(code));
}

function getClient(clientId) {
  return state.clients.get(clientId) || null;
}

function setClient(client) {
  state.clients.set(client.clientId, client);
}

function deleteClient(clientId) {
  state.clients.delete(clientId);
}

function listClients() {
  return Array.from(state.clients.values());
}

function getClientRoomId(clientId) {
  return state.clientRoomIndex.get(clientId) || null;
}

function setClientRoomId(clientId, roomId) {
  state.clientRoomIndex.set(clientId, roomId);
}

function deleteClientRoomId(clientId) {
  state.clientRoomIndex.delete(clientId);
}

module.exports = {
  rooms: state.rooms,
  roomCodeIndex: state.roomCodeIndex,
  clients: state.clients,
  clientRoomIndex: state.clientRoomIndex,
  getMemoryState,
  getRoom,
  setRoom,
  deleteRoom,
  listRooms,
  getRoomIdByJoinCode,
  hasJoinCode,
  setJoinCode,
  deleteJoinCode,
  getClient,
  setClient,
  deleteClient,
  listClients,
  getClientRoomId,
  setClientRoomId,
  deleteClientRoomId
};
