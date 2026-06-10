import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  Lock,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
  Upload
} from 'lucide-react';
import './styles.css';

type User = { id: string; email: string };
type AuthState = { accessToken: string; refreshToken: string; user: User };
type SentItem = {
  id: string;
  type: 'text' | 'file';
  textContent: string | null;
  fileId: string | null;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  isPrivate: boolean;
  createdAt: string;
};

const savedAuthKey = 'sentbox.auth';

function loadAuth(): AuthState | null {
  try {
    return JSON.parse(localStorage.getItem(savedAuthKey) || 'null');
  } catch {
    localStorage.removeItem(savedAuthKey);
    return null;
  }
}

function formatSize(size: number | null) {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileCanPreview(item: SentItem) {
  const mime = item.mimeType || '';
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf'
  );
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => loadAuth());
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<SentItem[]>([]);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const [privacyToken, setPrivacyToken] = useState<string | null>(null);
  const [privacyPassword, setPrivacyPassword] = useState('');
  const [showPrivacyDialog, setShowPrivacyDialog] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const thumbnailUrls = useRef<Record<string, string>>({});

  const privacyEnabled = Boolean(privacyToken);
  const eventsUrl = useMemo(() => {
    if (!auth) return '';
    return `/events?token=${encodeURIComponent(auth.accessToken)}`;
  }, [auth]);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> => {
    if (!auth) throw new Error('未登录');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${auth.accessToken}`);
    if (!headers.has('content-type') && init.body && !(init.body instanceof FormData)) {
      headers.set('content-type', 'application/json');
    }
    if (privacyToken) headers.set('x-privacy-token', privacyToken);

    const res = await fetch(path, { ...init, headers });
    if (res.status === 401 && allowRefresh) {
      const refreshed = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken })
      });
      if (refreshed.ok) {
        const next = { ...auth, ...(await refreshed.json()) };
        localStorage.setItem(savedAuthKey, JSON.stringify(next));
        setAuth(next);
        return request<T>(path, init, false);
      }
    }
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || '请求失败');
    return res.json();
  }, [auth, privacyToken]);

  const loadItems = useCallback(async () => {
    if (!auth) return;
    const query = privacyEnabled ? '?includePrivate=true' : '';
    const data = await request<{ items: SentItem[] }>(`/items${query}`);
    setItems(data.items);
  }, [auth, privacyEnabled, request]);

  useEffect(() => {
    loadItems().catch((err) => setStatus(err.message));
  }, [loadItems]);

  useEffect(() => {
    if (!auth || !eventsUrl) return;
    const source = new EventSource(eventsUrl);
    source.addEventListener('items.changed', () => {
      loadItems().catch((err) => setStatus(err.message));
    });
    source.onerror = () => setStatus('实时连接断开，浏览器会自动重连');
    return () => source.close();
  }, [auth, eventsUrl, loadItems]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    const visibleImageIds = new Set(
      items
        .filter((item) => item.type === 'file' && item.fileId && item.mimeType?.startsWith('image/'))
        .map((item) => item.id)
    );

    for (const [itemId, url] of Object.entries(thumbnailUrls.current)) {
      if (!visibleImageIds.has(itemId)) {
        URL.revokeObjectURL(url);
        delete thumbnailUrls.current[itemId];
      }
    }
    setThumbnails({ ...thumbnailUrls.current });

    for (const item of items) {
      if (item.type !== 'file' || !item.fileId || !item.mimeType?.startsWith('image/') || thumbnailUrls.current[item.id]) {
        continue;
      }
      fetchFileBlob(item, 'preview')
        .then((blob) => {
          if (!blob || cancelled) return;
          const url = URL.createObjectURL(blob);
          thumbnailUrls.current[item.id] = url;
          setThumbnails({ ...thumbnailUrls.current });
        })
        .catch(() => {
          // ??????????????????
        });
    }

    return () => {
      cancelled = true;
    };
  }, [auth, items, privacyToken]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(thumbnailUrls.current)) URL.revokeObjectURL(url);
      thumbnailUrls.current = {};
    };
  }, []);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const res = await fetch(`/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) throw new Error((await res.json()).error || '认证失败');
      const next = await res.json();
      localStorage.setItem(savedAuthKey, JSON.stringify(next));
      setAuth(next);
      setPassword('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '认证失败');
    } finally {
      setBusy(false);
    }
  }

  async function sendText(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setStatus('');
    try {
      await request('/items/text', {
        method: 'POST',
        body: JSON.stringify({ text: text.trim(), isPrivate })
      });
      setText('');
      setIsPrivate(false);
      await loadItems();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function sendFile() {
    if (!file) return;
    setBusy(true);
    setStatus('');
    try {
      const body = new FormData();
      body.set('isPrivate', String(isPrivate));
      body.set('file', file);
      await request('/items/file', { method: 'POST', body });
      setFile(null);
      setIsPrivate(false);
      if (fileInput.current) fileInput.current.value = '';
      await loadItems();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '上传失败');
    } finally {
      setBusy(false);
    }
  }

  async function verifyPrivacy(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const data = await request<{ privacyToken: string }>('/auth/privacy/verify', {
        method: 'POST',
        body: JSON.stringify({ password: privacyPassword })
      });
      setPrivacyToken(data.privacyToken);
      setPrivacyPassword('');
      setShowPrivacyDialog(false);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '隐私验证失败');
    } finally {
      setBusy(false);
    }
  }


  async function copyText(value: string | null) {
    try {
      await navigator.clipboard.writeText(value || '');
      setStatus('文本已复制');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '复制失败');
    }
  }
  async function fetchFileBlob(item: SentItem, action: 'download' | 'preview') {
    if (!item.fileId || !auth) return null;
    const headers = new Headers({ authorization: `Bearer ${auth.accessToken}` });
    if (privacyToken) headers.set('x-privacy-token', privacyToken);
    const res = await fetch(`/files/${item.fileId}/${action}`, { headers });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || '文件请求失败');
    return res.blob();
  }

  async function downloadFile(item: SentItem) {
    try {
      const blob = await fetchFileBlob(item, 'download');
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.fileName || 'download';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '下载失败');
    }
  }

  async function previewFile(item: SentItem) {
    if (!fileCanPreview(item)) {
      setStatus('该文件类型不支持浏览器预览，请下载查看');
      return;
    }
    try {
      const blob = await fetchFileBlob(item, 'preview');
      if (!blob) return;
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(blob), name: item.fileName || '预览', mime: item.mimeType || 'application/octet-stream' });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '预览失败');
    }
  }

  function logout() {
    localStorage.removeItem(savedAuthKey);
    for (const url of Object.values(thumbnailUrls.current)) URL.revokeObjectURL(url);
    thumbnailUrls.current = {};
    setThumbnails({});
    setAuth(null);
    setPrivacyToken(null);
    setItems([]);
  }

  if (!auth) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div>
            <p className="eyebrow">Sentbox Web</p>
            <h1>多端发送箱</h1>
            <p className="muted">登录同一个账号，在多个网页端实时查看发送记录。</p>
          </div>
          <form onSubmit={submitAuth} className="form-stack">
            <label>
              邮箱
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
            </label>
            <label>
              密码
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} required />
            </label>
            <button className="primary" disabled={busy}>
              <ShieldCheck size={18} />
              {mode === 'login' ? '登录' : '注册'}
            </button>
          </form>
          <button className="text-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
          </button>
          {status && <p className="status">{status}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sentbox Web</p>
          <h1>多端发送箱</h1>
          <p className="muted">{auth.user.email}</p>
        </div>
        <div className="top-actions">
          <button className={privacyEnabled ? 'success' : 'ghost'} onClick={() => privacyEnabled ? setPrivacyToken(null) : setShowPrivacyDialog(true)}>
            {privacyEnabled ? <Eye size={18} /> : <EyeOff size={18} />}
            {privacyEnabled ? '隐私已开启' : '开启隐私'}
          </button>
          <button className="ghost icon-only" onClick={() => loadItems()} title="刷新" aria-label="刷新">
            <RefreshCw size={18} />
          </button>
          <button className="ghost icon-only" onClick={logout} title="退出" aria-label="退出">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="composer">
          <form onSubmit={sendText} className="compose-section">
            <h2>发送文本</h2>
            <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要发送的文本" rows={7} />
            <PrivacyToggle checked={isPrivate} onChange={setIsPrivate} />
            <button className="primary" disabled={busy || !text.trim()}>
              <Send size={18} />
              发送文本
            </button>
          </form>

          <div className="compose-section">
            <h2>发送文件</h2>
            <label className="file-picker">
              <Upload size={22} />
              <span>{file ? file.name : '选择文件'}</span>
              <input ref={fileInput} type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </label>
            {file && <p className="muted">{file.type || '未知类型'} · {formatSize(file.size)}</p>}
            <PrivacyToggle checked={isPrivate} onChange={setIsPrivate} />
            <button className="primary" onClick={sendFile} disabled={busy || !file}>
              <Upload size={18} />
              上传文件
            </button>
          </div>
          {status && <p className="status">{status}</p>}
        </aside>

        <section className="list-panel">
          <div className="list-header">
            <div>
              <h2>已发送列表</h2>
              <p className="muted">{privacyEnabled ? '包含隐私内容' : '仅显示普通内容'}</p>
            </div>
            <span className="count">{items.length}</span>
          </div>
          <div className="items">
            {items.length === 0 && <div className="empty">暂无发送记录</div>}
            {items.map((item) => (
              <article className="item" key={item.id}>
                <div className="item-main">
                  <div className={"item-icon " + (thumbnails[item.id] ? 'thumbnail' : '')}>
                    {thumbnails[item.id] ? (
                      <img src={thumbnails[item.id]} alt={item.fileName || '?????'} />
                    ) : item.type === 'text' ? (
                      <FileText size={19} />
                    ) : (
                      <Upload size={19} />
                    )}
                  </div>
                  <div>
                    <div className="item-title">
                      {item.type === 'text' ? '文本' : item.fileName}
                      {item.isPrivate && <span className="private-badge"><Lock size={13} />隐私</span>}
                    </div>
                    {item.type === 'text' ? (
                      <p className="item-text">{item.textContent}</p>
                    ) : (
                      <p className="muted">{item.mimeType || '未知类型'} · {formatSize(item.size)}</p>
                    )}
                    <time>{new Date(item.createdAt).toLocaleString()}</time>
                  </div>
                </div>
                <div className="item-actions">
                  {item.type === 'text' ? (
                    <button className="ghost icon-only" title="复制" aria-label="复制" onClick={() => copyText(item.textContent)}>
                      <Copy size={18} />
                    </button>
                  ) : (
                    <>
                      <button className="ghost icon-only" title="预览" aria-label="预览" onClick={() => previewFile(item)}>
                        <Eye size={18} />
                      </button>
                      <button className="ghost icon-only" title="下载" aria-label="下载" onClick={() => downloadFile(item)}>
                        <Download size={18} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      {showPrivacyDialog && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <form className="modal" onSubmit={verifyPrivacy}>
            <h2>开启隐私模式</h2>
            <p className="muted">请输入当前账号密码。验证成功后，本页面会显示隐私发送记录。</p>
            <input value={privacyPassword} onChange={(event) => setPrivacyPassword(event.target.value)} type="password" autoFocus />
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowPrivacyDialog(false)}>取消</button>
              <button className="primary" disabled={busy || !privacyPassword}>验证</button>
            </div>
          </form>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="preview-modal">
            <div className="preview-header">
              <h2>{preview.name}</h2>
              <button className="ghost" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>关闭</button>
            </div>
            {preview.mime.startsWith('image/') && <img src={preview.url} alt={preview.name} />}
            {preview.mime === 'application/pdf' && <iframe src={preview.url} title={preview.name} />}
            {preview.mime.startsWith('text/') && <iframe src={preview.url} title={preview.name} />}
            {preview.mime.startsWith('audio/') && <audio src={preview.url} controls />}
            {preview.mime.startsWith('video/') && <video src={preview.url} controls />}
          </div>
        </div>
      )}
    </main>
  );
}

function PrivacyToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="privacy-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><Lock size={15} />标记为隐私</span>
    </label>
  );
}

createRoot(document.getElementById('root')!).render(<App />);