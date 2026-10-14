import { hasHost, postToHost } from '../float/float-view';
import { desktopApi } from './desktop-api';
export async function launchNativeReader(sessionId: string): Promise<void> {
  if (!hasHost()) throw new Error('内置共读浏览器仅在安装版可用');
  const pair = await desktopApi.pair(sessionId);
  if (!/^[a-f0-9]{10}$/i.test(pair.code)) throw new Error('共读连接码无效，请重试');
  postToHost('sb-desktop:reader:' + pair.code.toLowerCase());
}
