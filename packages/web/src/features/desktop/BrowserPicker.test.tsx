// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({preference:vi.fn(),choose:vi.fn()}));
vi.mock('./desktop-api',()=>({desktopApi:{browserPreference:fake.preference,chooseBrowser:fake.choose}}));
import { BrowserPicker } from './BrowserPicker';
beforeEach(()=>{vi.clearAllMocks();fake.preference.mockResolvedValue({selected:'edge',available:['chrome','edge']});fake.choose.mockResolvedValue({selected:'chrome',available:['chrome','edge']});});
afterEach(cleanup);
it('shows installed choices, saves the same browser for reader and GitHub and makes failures visible',async()=>{
  render(<BrowserPicker readerSetupHint={false}/>);const picker=await screen.findByRole('combobox');
  expect(screen.getByText(/此插件入口不需要共读扩展/)).toBeTruthy();
  expect((picker as HTMLSelectElement).value).toBe('edge');fireEvent.change(picker,{target:{value:'chrome'}});
  await waitFor(()=>expect(fake.choose).toHaveBeenCalledWith('chrome'));
  await waitFor(()=>expect((picker as HTMLSelectElement).value).toBe('chrome'));
  fake.choose.mockRejectedValueOnce(new Error('未找到浏览器'));fireEvent.change(picker,{target:{value:'edge'}});
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','未找到浏览器');
  expect((picker as HTMLSelectElement).value).toBe('chrome');
});
it('does not claim browser selection is available outside a desktop service',async()=>{
  fake.preference.mockRejectedValueOnce(new Error('404'));render(<BrowserPicker />);
  await waitFor(()=>expect(fake.preference).toHaveBeenCalled());expect(screen.queryByRole('combobox')).toBeNull();
});
