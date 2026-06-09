import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='memory';
process.env.JWT_SECRET='test';
process.env.REFRESH_SECRET='test';
process.env.UPLOAD_DIR='./uploads-test';
const { buildApp } = await import('../src/index.js');

test('registers a device, syncs clipboard, uploads and downloads a file', async()=>{
  const app=await buildApp();
  const reg=await app.inject({method:'POST',url:'/auth/register',payload:{email:'a@test.com',password:'password123'}});
  assert.equal(reg.statusCode,200); const token=reg.json().accessToken;
  const dev=await app.inject({method:'POST',url:'/devices/register',headers:{authorization:`Bearer ${token}`},payload:{name:'Win',platform:'windows',publicKey:'pub'}});
  assert.equal(dev.statusCode,200); const deviceId=dev.json().device.id;
  const clip=await app.inject({method:'POST',url:'/events/clipboard',headers:{authorization:`Bearer ${token}`},payload:{deviceId,ciphertext:'abc',nonce:'n',contentHash:'h'}});
  assert.equal(clip.statusCode,200);
  const init=await app.inject({method:'POST',url:'/files/upload/init',headers:{authorization:`Bearer ${token}`},payload:{deviceId,targetDeviceIds:[deviceId],encryptedMetadata:'m',size:3,chunkSize:3}});
  assert.equal(init.statusCode,200); const uploadId=init.json().uploadId;
  assert.equal((await app.inject({method:'PUT',url:`/files/upload/${uploadId}/chunk?index=0`,headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},payload:Buffer.from('xyz')})).statusCode,200);
  const done=await app.inject({method:'POST',url:`/files/upload/${uploadId}/complete`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(done.statusCode,200);
  const dl=await app.inject({method:'GET',url:`/files/${done.json().fileId}/download`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(dl.body,'xyz');
  await app.close();
});
