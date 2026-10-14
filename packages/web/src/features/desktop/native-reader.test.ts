// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({host:true,pair:vi.fn(),post:vi.fn()}));
vi.mock('../float/float-view',()=>({hasHost:()=>fake.host,postToHost:fake.post}));
vi.mock('./desktop-api',()=>({desktopApi:{pair:fake.pair}}));
import { launchNativeReader } from './native-reader';
beforeEach(()=>{fake.host=true;vi.clearAllMocks();fake.pair.mockResolvedValue({code:'123456abcd',endpoint:'http://evil.invalid/ignored'});});
it('pairs current session automatically and sends only a bounded one-time code, never an endpoint',async()=>{
  await launchNativeReader('current');expect(fake.pair).toHaveBeenCalledWith('current');expect(fake.post).toHaveBeenCalledWith('sb-desktop:reader:123456abcd');
});
it('does not open remote-host commands or pair without a native bridge',async()=>{
  fake.pair.mockResolvedValueOnce({code:'../../command'});await expect(launchNativeReader('s')).rejects.toThrow('无效');expect(fake.post).not.toHaveBeenCalled();
  fake.host=false;await expect(launchNativeReader('s')).rejects.toThrow('安装版');expect(fake.pair).toHaveBeenCalledTimes(1);
});
it('normalizes the real backend uppercase pairing codes to the native protocol',async()=>{
  fake.pair.mockResolvedValueOnce({code:'ABCD123456'});await launchNativeReader('s');expect(fake.post).toHaveBeenCalledWith('sb-desktop:reader:abcd123456');
});
