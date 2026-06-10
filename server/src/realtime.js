const clientsByUser = new Map();

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function addEventClient(userId, res) {
  const clients = clientsByUser.get(userId) || new Set();
  clients.add(res);
  clientsByUser.set(userId, clients);

  writeEvent(res, 'connected', { type: 'connected', createdAt: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) clientsByUser.delete(userId);
  });
}

export function broadcastUserChanged(userId) {
  const payload = {
    type: 'items.changed',
    createdAt: new Date().toISOString()
  };
  for (const client of clientsByUser.get(userId) || []) {
    if (!client.destroyed) writeEvent(client, 'items.changed', payload);
  }
}