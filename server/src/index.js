import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, isMemory, getMem, q } from './db.js';
import { signAccess, verifyAccess, newRefreshToken } from './tokens.js';
import { addSocket, broadcastToUser, sendToDevices } from './events.js';

const uploadDir = process.env.UPLOAD_DIR || './uploads';
const retentionDays = Number(process.env.FILE_RETENTION_DAYS || 7);
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 1073741824);

function publicUser(u){ return { id:u.id, email:u.email, createdAt:u.created_at || u.createdAt }; }
function nowIso(){ return new Date().toISOString(); }
function expires(days=retentionDays){ return new Date(Date.now()+days*86400000); }
function authPreHandler(){ return async (req, reply)=>{
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return reply.code(401).send({error:'missing_token'});
  try{ req.auth=verifyAccess(token); req.userId=req.auth.sub; }catch{ return reply.code(401).send({error:'invalid_token'}); }
};}
async function saveRefresh(userId, token){
  const expiresAt = new Date(Date.now()+30*86400000);
  if(isMemory()) getMem().refreshTokens.push({token,user_id:userId,expires_at:expiresAt});
  else await q('insert into refresh_tokens(token,user_id,expires_at) values($1,$2,$3)',[token,userId,expiresAt]);
}
async function issue(userId){ const refreshToken=newRefreshToken(); await saveRefresh(userId,refreshToken); return {accessToken:signAccess(userId),refreshToken}; }
async function findUserByEmail(email){
  if(isMemory()) return getMem().users.find(u=>u.email===email);
  return (await q('select * from users where email=$1',[email])).rows[0];
}
async function findDevice(userId, id){
  if(isMemory()) return getMem().devices.find(d=>d.user_id===userId && d.id===id);
  return (await q('select * from devices where user_id=$1 and id=$2',[userId,id])).rows[0];
}

export async function buildApp() {
  await mkdir(uploadDir,{recursive:true});
  await initDb();
  const app=Fastify({logger:{level:process.env.LOG_LEVEL||'info'}});
  await app.register(cors,{origin:process.env.CORS_ORIGIN||'*'});
  await app.register(websocket);
  await app.register(multipart,{limits:{fileSize:maxFileBytes}});
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/health', async()=>({ok:true, service:'sync-relay', time:nowIso()}));

  app.post('/auth/register', async(req, reply)=>{
    const {email,password}=req.body||{};
    if(!email || !password || password.length<8) return reply.code(400).send({error:'email_and_password_min_8_required'});
    if(await findUserByEmail(email)) return reply.code(409).send({error:'email_exists'});
    const user={id:randomUUID(),email,password_hash:await bcrypt.hash(password,10),created_at:new Date()};
    if(isMemory()) getMem().users.push(user); else await q('insert into users(id,email,password_hash) values($1,$2,$3)',[user.id,user.email,user.password_hash]);
    return {...await issue(user.id), user:publicUser(user)};
  });

  app.post('/auth/login', async(req, reply)=>{
    const {email,password}=req.body||{}; const user=await findUserByEmail(email||'');
    if(!user || !await bcrypt.compare(password||'', user.password_hash)) return reply.code(401).send({error:'invalid_credentials'});
    return {...await issue(user.id), user:publicUser(user)};
  });

  app.post('/auth/refresh', async(req, reply)=>{
    const {refreshToken}=req.body||{}; let row;
    if(isMemory()) row=getMem().refreshTokens.find(t=>t.token===refreshToken && t.expires_at>new Date());
    else row=(await q('select * from refresh_tokens where token=$1 and expires_at>now()',[refreshToken])).rows[0];
    if(!row) return reply.code(401).send({error:'invalid_refresh'});
    return await issue(row.user_id);
  });

  app.get('/devices',{preHandler:authPreHandler()}, async(req)=>{
    if(isMemory()) return {devices:getMem().devices.filter(d=>d.user_id===req.userId)};
    return {devices:(await q('select id,name,platform,public_key,last_seen_at,trusted,created_at from devices where user_id=$1 order by created_at desc',[req.userId])).rows};
  });

  app.post('/devices/register',{preHandler:authPreHandler()}, async(req, reply)=>{
    const {name,platform,publicKey}=req.body||{}; if(!name||!platform||!publicKey) return reply.code(400).send({error:'missing_fields'});
    const device={id:randomUUID(),user_id:req.userId,name,platform,public_key:publicKey,last_seen_at:new Date(),trusted:true,created_at:new Date()};
    if(isMemory()) getMem().devices.push(device); else await q('insert into devices(id,user_id,name,platform,public_key,last_seen_at,trusted) values($1,$2,$3,$4,$5,$6,true)',[device.id,device.user_id,name,platform,publicKey,device.last_seen_at]);
    return {device};
  });

  app.delete('/devices/:id',{preHandler:authPreHandler()}, async(req)=>{
    if(isMemory()) getMem().devices=getMem().devices.filter(d=>!(d.user_id===req.userId&&d.id===req.params.id));
    else await q('delete from devices where user_id=$1 and id=$2',[req.userId,req.params.id]);
    return {ok:true};
  });

  app.post('/devices/pair/start',{preHandler:authPreHandler()}, async(req, reply)=>{
    const {deviceName,platform,publicKey}=req.body||{}; if(!deviceName||!platform||!publicKey) return reply.code(400).send({error:'missing_fields'});
    const code=String(Math.floor(100000+Math.random()*900000)); const expiresAt=new Date(Date.now()+10*60000);
    const row={code,user_id:req.userId,device_name:deviceName,platform,public_key:publicKey,expires_at:expiresAt};
    if(isMemory()) getMem().pairingRequests.push(row); else await q('insert into pairing_requests(code,user_id,device_name,platform,public_key,expires_at) values($1,$2,$3,$4,$5,$6)',[code,req.userId,deviceName,platform,publicKey,expiresAt]);
    broadcastToUser(req.userId,{type:'pairing.request',id:randomUUID(),createdAt:nowIso(),payload:{pairingCode:code,deviceName,platform,publicKey}});
    return {pairingCode:code,expiresAt};
  });

  app.post('/devices/pair/confirm',{preHandler:authPreHandler()}, async(req, reply)=>{
    const {pairingCode,encryptedKeyEnvelope}=req.body||{}; if(!pairingCode||!encryptedKeyEnvelope) return reply.code(400).send({error:'missing_fields'});
    let pr; if(isMemory()) pr=getMem().pairingRequests.find(p=>p.code===pairingCode&&p.user_id===req.userId&&p.expires_at>new Date());
    else pr=(await q('select * from pairing_requests where code=$1 and user_id=$2 and expires_at>now()',[pairingCode,req.userId])).rows[0];
    if(!pr) return reply.code(404).send({error:'pairing_not_found'});
    const device={id:randomUUID(),user_id:req.userId,name:pr.device_name,platform:pr.platform,public_key:pr.public_key,last_seen_at:new Date(),trusted:true,created_at:new Date()};
    if(isMemory()){ getMem().devices.push(device); getMem().pairingRequests=getMem().pairingRequests.filter(p=>p.code!==pairingCode); }
    else { await q('insert into devices(id,user_id,name,platform,public_key,last_seen_at,trusted) values($1,$2,$3,$4,$5,$6,true)',[device.id,device.user_id,device.name,device.platform,device.public_key,device.last_seen_at]); await q('delete from pairing_requests where code=$1',[pairingCode]); }
    broadcastToUser(req.userId,{type:'pairing.confirmed',id:randomUUID(),createdAt:nowIso(),payload:{device,encryptedKeyEnvelope}});
    return {ok:true,device};
  });

  app.post('/events/clipboard',{preHandler:authPreHandler()}, async(req, reply)=>{
    const {deviceId,targetDeviceIds,ciphertext,nonce,contentHash}=req.body||{}; if(!deviceId||!ciphertext||!nonce) return reply.code(400).send({error:'missing_fields'});
    if(!await findDevice(req.userId,deviceId)) return reply.code(403).send({error:'unknown_device'});
    const eventId=randomUUID(); const event={type:'clipboard.update',id:eventId,createdAt:nowIso(),senderDeviceId:deviceId,targetDeviceIds:targetDeviceIds||[],payload:{ciphertext,nonce,contentHash}};
    if(isMemory()) getMem().clipboardEvents.push({id:eventId,user_id:req.userId,sender_device_id:deviceId,target_device_ids:targetDeviceIds,ciphertext,nonce,content_hash:contentHash,created_at:new Date()});
    else await q('insert into clipboard_events(id,user_id,sender_device_id,target_device_ids,ciphertext,nonce,content_hash) values($1,$2,$3,$4,$5,$6,$7)',[eventId,req.userId,deviceId,JSON.stringify(targetDeviceIds||[]),ciphertext,nonce,contentHash]);
    targetDeviceIds?.length ? sendToDevices(targetDeviceIds,event) : broadcastToUser(req.userId,event,deviceId);
    return {eventId};
  });

  app.post('/files/upload/init',{preHandler:authPreHandler()}, async(req, reply)=>{
    const {deviceId,targetDeviceIds,encryptedMetadata,size,chunkSize}=req.body||{};
    if(!deviceId||!Array.isArray(targetDeviceIds)||!encryptedMetadata||!size) return reply.code(400).send({error:'missing_fields'});
    if(size>maxFileBytes) return reply.code(413).send({error:'file_too_large'});
    const uploadId=randomUUID(), id=randomUUID(), exp=expires();
    const row={id,upload_id:uploadId,user_id:req.userId,sender_device_id:deviceId,target_device_ids:targetDeviceIds,encrypted_metadata:encryptedMetadata,size,chunk_size:chunkSize||1048576,status:'uploading',expires_at:exp,created_at:new Date()};
    if(isMemory()) getMem().fileTransfers.push(row); else await q('insert into file_transfers(id,upload_id,user_id,sender_device_id,target_device_ids,encrypted_metadata,size,chunk_size,status,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,uploadId,req.userId,deviceId,JSON.stringify(targetDeviceIds),encryptedMetadata,size,row.chunk_size,'uploading',exp]);
    await mkdir(path.join(uploadDir,uploadId),{recursive:true}); return {uploadId};
  });

  app.put('/files/upload/:uploadId/chunk',{preHandler:authPreHandler()}, async(req, reply)=>{
    const index=Number(req.query.index||0); if(!Number.isInteger(index)||index<0) return reply.code(400).send({error:'bad_index'});
    const buf=await req.body; await mkdir(path.join(uploadDir,req.params.uploadId),{recursive:true}); await writeFile(path.join(uploadDir,req.params.uploadId,`${index}.bin`),buf);
    return {ok:true};
  });

  app.post('/files/upload/:uploadId/complete',{preHandler:authPreHandler()}, async(req, reply)=>{
    let ft; if(isMemory()) ft=getMem().fileTransfers.find(f=>f.upload_id===req.params.uploadId&&f.user_id===req.userId); else ft=(await q('select * from file_transfers where upload_id=$1 and user_id=$2',[req.params.uploadId,req.userId])).rows[0];
    if(!ft) return reply.code(404).send({error:'upload_not_found'});
    if(isMemory()) ft.status='ready'; else await q('update file_transfers set status=$1 where upload_id=$2',['ready',req.params.uploadId]);
    const event={type:'file.offer',id:ft.id,createdAt:nowIso(),senderDeviceId:ft.sender_device_id,targetDeviceIds:ft.target_device_ids,payload:{fileId:ft.id,encryptedMetadata:ft.encrypted_metadata,size:Number(ft.size),expiresAt:ft.expires_at}};
    sendToDevices(ft.target_device_ids,event); return {fileId:ft.id};
  });

  app.get('/files/:fileId/download',{preHandler:authPreHandler()}, async(req, reply)=>{
    let ft; if(isMemory()) ft=getMem().fileTransfers.find(f=>f.id===req.params.fileId&&f.user_id===req.userId); else ft=(await q('select * from file_transfers where id=$1 and user_id=$2',[req.params.fileId,req.userId])).rows[0];
    if(!ft) return reply.code(404).send({error:'file_not_found'});
    const dir=path.join(uploadDir,ft.upload_id); const chunks=[]; for(let i=0;;i++){ try{ chunks.push(await readFile(path.join(dir,`${i}.bin`))); }catch{ break; } }
    return reply.header('content-type','application/octet-stream').send(Buffer.concat(chunks));
  });

  app.delete('/maintenance/expired-files',{preHandler:authPreHandler()}, async(req)=>{
    const expired=isMemory()?getMem().fileTransfers.filter(f=>f.expires_at<new Date()):(await q('select * from file_transfers where expires_at<now()')).rows;
    for(const f of expired) await rm(path.join(uploadDir,f.upload_id),{recursive:true,force:true});
    if(isMemory()) getMem().fileTransfers=getMem().fileTransfers.filter(f=>f.expires_at>=new Date()); else await q('delete from file_transfers where expires_at<now()');
    return {ok:true,deleted:expired.length};
  });

  app.get('/ws',{websocket:true}, (conn, req)=>{
    try{
      const url=new URL(req.url,'http://localhost'); const token=url.searchParams.get('token'); const deviceId=url.searchParams.get('deviceId');
      const userId=verifyAccess(token).sub; conn.socket.deviceId=deviceId; addSocket(userId,deviceId,conn.socket);
      broadcastToUser(userId,{type:'device.online',id:randomUUID(),createdAt:nowIso(),senderDeviceId:deviceId,payload:{deviceId}},deviceId);
      conn.socket.on('close',()=>broadcastToUser(userId,{type:'device.offline',id:randomUUID(),createdAt:nowIso(),senderDeviceId:deviceId,payload:{deviceId}},deviceId));
    } catch { conn.socket.close(1008,'unauthorized'); }
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app=await buildApp();
  app.listen({port:Number(process.env.PORT||8787),host:'0.0.0.0'}).catch(err=>{app.log.error(err);process.exit(1);});
}
