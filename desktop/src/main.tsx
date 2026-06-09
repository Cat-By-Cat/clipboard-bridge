import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './styles.css';

type Device = { id:string; name:string; platform:string; trusted:boolean; last_seen_at?:string };
type Session = { serverUrl:string; accessToken:string; deviceId:string; syncKey:string };

async function api(path:string, session:Pick<Session,'serverUrl'|'accessToken'>, init:RequestInit={}){
  const res=await fetch(`${session.serverUrl}${path}`,{...init,headers:{'content-type':'application/json',authorization:`Bearer ${session.accessToken}`,...init.headers}});
  if(!res.ok) throw new Error(await res.text()); return res.json();
}

function App(){
  const [serverUrl,setServerUrl]=useState(localStorage.serverUrl||'http://localhost:8787');
  const [email,setEmail]=useState(''); const [password,setPassword]=useState('');
  const [session,setSession]=useState<Session|null>(()=>localStorage.session?JSON.parse(localStorage.session):null);
  const [devices,setDevices]=useState<Device[]>([]); const [log,setLog]=useState<string[]>([]);
  const [clipboardEnabled,setClipboardEnabled]=useState(true); const [selected,setSelected]=useState<string[]>([]);
  const wsUrl=useMemo(()=>session?session.serverUrl.replace(/^http/,'ws'):``,[session]);
  const addLog=(s:string)=>setLog(v=>[`${new Date().toLocaleTimeString()} ${s}`,...v].slice(0,80));

  async function login(register=false){
    const res=await fetch(`${serverUrl}/auth/${register?'register':'login'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
    if(!res.ok){ addLog(`?????${await res.text()}`); return; }
    const auth=await res.json();
    const publicKey=await invoke<string>('device_public_key');
    const dev=await api('/devices/register',{serverUrl,accessToken:auth.accessToken},{method:'POST',body:JSON.stringify({name:await invoke('device_name'),platform:await invoke('platform'),publicKey})});
    const syncKey=localStorage.syncKey || crypto.randomUUID().replace(/-/g,''); localStorage.syncKey=syncKey;
    const s={serverUrl,accessToken:auth.accessToken,deviceId:dev.device.id,syncKey}; localStorage.session=JSON.stringify(s); localStorage.serverUrl=serverUrl; setSession(s); addLog('????????');
  }
  async function loadDevices(){ if(session) setDevices((await api('/devices',session)).devices); }
  useEffect(()=>{ loadDevices().catch(e=>addLog(e.message)); },[session]);
  useEffect(()=>{
    if(!session) return; let closed=false; let ws:WebSocket;
    const connect=()=>{ ws=new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(session.accessToken)}&deviceId=${session.deviceId}`);
      ws.onopen=()=>addLog('WebSocket ???'); ws.onclose=()=>!closed&&setTimeout(connect,2000);
      ws.onmessage=async ev=>{ const msg=JSON.parse(ev.data); addLog(`???? ${msg.type}`); if(msg.type==='clipboard.update'&&msg.senderDeviceId!==session.deviceId){ await invoke('apply_remote_clipboard',{ciphertext:msg.payload.ciphertext, nonce:msg.payload.nonce, syncKey:session.syncKey}); }};
    }; connect(); return()=>{closed=true; ws?.close();};
  },[session]);
  useEffect(()=>{ if(!session) return; const id=setInterval(async()=>{ if(!clipboardEnabled) return; const changed=await invoke<any>('poll_clipboard',{syncKey:session.syncKey}); if(changed?.ciphertext){ await api('/events/clipboard',session,{method:'POST',body:JSON.stringify({deviceId:session.deviceId,targetDeviceIds:selected,ciphertext:changed.ciphertext,nonce:changed.nonce,contentHash:changed.contentHash})}); addLog('????????'); }},1000); return()=>clearInterval(id); },[session,clipboardEnabled,selected]);
  async function sendFile(){ if(!session) return; const r=await invoke<any>('encrypt_and_pick_file',{syncKey:session.syncKey}); if(!r) return; const init=await api('/files/upload/init',session,{method:'POST',body:JSON.stringify({deviceId:session.deviceId,targetDeviceIds:selected,encryptedMetadata:r.encryptedMetadata,size:r.bytes.length,chunkSize:r.bytes.length})}); await fetch(`${session.serverUrl}/files/upload/${init.uploadId}/chunk?index=0`,{method:'PUT',headers:{authorization:`Bearer ${session.accessToken}`,'content-type':'application/octet-stream'},body:new Uint8Array(r.bytes)}); const done=await api(`/files/upload/${init.uploadId}/complete`,session,{method:'POST'}); addLog(`文件已发送：${done.fileId}`); }
  if(!session) return <main className="card"><h1>?????</h1><input value={serverUrl} onChange={e=>setServerUrl(e.target.value)} placeholder="?????"/><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="??"/><input value={password} onChange={e=>setPassword(e.target.value)} type="password" placeholder="???? 8 ?"/><div><button onClick={()=>login(false)}>??</button><button onClick={()=>login(true)}>??</button></div><Log log={log}/></main>;
  return <main><header><h1>?????</h1><button onClick={()=>{localStorage.removeItem('session');setSession(null)}}>??</button></header><section className="grid"><div className="panel"><h2>??</h2><button onClick={loadDevices}>??</button>{devices.map(d=><label className="row" key={d.id}><input type="checkbox" checked={selected.includes(d.id)} onChange={e=>setSelected(e.target.checked?[...selected,d.id]:selected.filter(x=>x!==d.id))}/><span>{d.name} ? {d.platform}</span></label>)}</div><div className="panel"><h2>??</h2><label><input type="checkbox" checked={clipboardEnabled} onChange={e=>setClipboardEnabled(e.target.checked)}/> ???????????</label><p>?????????????????????</p><button onClick={sendFile}>?????????/??</button></div><div className="panel"><h2>??</h2><Log log={log}/></div></section></main>;
}
function Log({log}:{log:string[]}){ return <pre className="log">{log.join('\n')}</pre>; }
createRoot(document.getElementById('root')!).render(<App/>);
