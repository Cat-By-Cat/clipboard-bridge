declare global {
  interface Window {
    electronNative?: {
      invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}

export async function nativeInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (window.electronNative) {
    return window.electronNative.invoke<T>(command, args);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export {};
