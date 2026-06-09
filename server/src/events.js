const socketsByUser = new Map();
const socketsByDevice = new Map();

export function addSocket(userId, deviceId, ws) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(ws);
  socketsByDevice.set(deviceId, ws);
  ws.on('close', () => {
    socketsByUser.get(userId)?.delete(ws);
    socketsByDevice.delete(deviceId);
  });
}

export function broadcastToUser(userId, event, exceptDeviceId=null) {
  const json = JSON.stringify(event);
  for (const ws of socketsByUser.get(userId) || []) {
    if (ws.deviceId === exceptDeviceId) continue;
    if (ws.readyState === 1) ws.send(json);
  }
}

export function sendToDevices(deviceIds, event) {
  const json = JSON.stringify(event);
  for (const id of deviceIds || []) {
    const ws = socketsByDevice.get(id);
    if (ws?.readyState === 1) ws.send(json);
  }
}
