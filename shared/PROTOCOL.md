# ???? v1

## REST

- `POST /auth/register` `{ email, password }` -> `{ accessToken, refreshToken, user }`
- `POST /auth/login` `{ email, password }` -> `{ accessToken, refreshToken, user }`
- `POST /auth/refresh` `{ refreshToken }` -> `{ accessToken, refreshToken }`
- `GET /devices` -> `{ devices }`
- `POST /devices/register` `{ name, platform, publicKey }` -> `{ device }`
- `DELETE /devices/:id` -> `{ ok: true }`
- `POST /devices/pair/start` `{ deviceName, platform, publicKey }` -> `{ pairingCode, expiresAt }`
- `POST /devices/pair/confirm` `{ pairingCode, encryptedKeyEnvelope }` -> `{ ok: true }`
- `POST /events/clipboard` `{ deviceId, targetDeviceIds?, ciphertext, nonce, contentHash }` -> `{ eventId }`
- `POST /files/upload/init` `{ deviceId, targetDeviceIds, encryptedMetadata, size, chunkSize }` -> `{ uploadId }`
- `PUT /files/upload/:uploadId/chunk?index=0` raw encrypted bytes -> `{ ok: true }`
- `POST /files/upload/:uploadId/complete` -> `{ fileId }`
- `GET /files/:fileId/download` -> encrypted bytes
- `GET /health` -> `{ ok: true }`

## WebSocket

???`ws://host/ws?token=<accessToken>&deviceId=<deviceId>`

???????

```json
{
  "type": "clipboard.update",
  "id": "uuid",
  "createdAt": "iso8601",
  "senderDeviceId": "uuid",
  "targetDeviceIds": ["uuid"],
  "payload": {}
}
```

?????

- `device.online`
- `device.offline`
- `clipboard.update`
- `file.offer`
- `file.accepted`
- `file.downloaded`
- `file.failed`
- `pairing.request`
- `pairing.confirmed`

## ?????

????????? `contentHash` ????????

1. ???????????? hash???????? hash?
2. ?????????????????????
3. ????????????????
