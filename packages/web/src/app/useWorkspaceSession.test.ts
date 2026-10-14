// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
const mock = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(async (_id: string | null) => ({ sessionId: _id })) }));
vi.mock('../features/desktop/desktop-api', () => ({ desktopApi: { workspace: mock.load, saveWorkspace: mock.save } }));
import { useWorkspaceSession } from './useWorkspaceSession';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('restores only the companion selection and never saves the initial null over it', async () => {
  mock.load.mockResolvedValue({ sessionId: 'saved' });
  const { result } = renderHook(() => useWorkspaceSession(true));
  expect(result.current.restoring).toBe(true);
  await waitFor(() => expect(result.current.currentId).toBe('saved'));
  expect(result.current.restoring).toBe(false); expect(mock.save).not.toHaveBeenCalled();
});
it('the main window keeps its fresh-start behavior', () => {
  const { result } = renderHook(() => useWorkspaceSession(false));
  act(() => result.current.setCurrentId('main'));
  expect(result.current.currentId).toBe('main'); expect(mock.load).not.toHaveBeenCalled(); expect(mock.save).not.toHaveBeenCalled();
});
it('explicit navigation wins over a delayed restore', async () => {
  let resolve!: (state: { sessionId: string | null }) => void;
  mock.load.mockReturnValue(new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useWorkspaceSession(true));
  act(() => result.current.setCurrentId('new'));
  await act(async () => { resolve({ sessionId: 'old' }); });
  expect(result.current.currentId).toBe('new');
});
it('serializes rapid session changes, including clearing the current selection', async () => {
  mock.load.mockResolvedValue({ sessionId: 'old' });
  let resolve!: (state: { sessionId: string | null }) => void;
  mock.save.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useWorkspaceSession(true));
  await waitFor(() => expect(result.current.restoring).toBe(false));
  act(() => { result.current.setCurrentId('a'); result.current.setCurrentId(null); });
  await waitFor(() => expect(mock.save).toHaveBeenCalledTimes(1));
  await act(async () => { resolve({ sessionId: 'a' }); });
  await waitFor(() => expect(mock.save).toHaveBeenLastCalledWith(null));
  expect(result.current.currentId).toBeNull();
});
it('an unavailable endpoint does not block navigation or clear saved state', async () => {
  mock.load.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useWorkspaceSession(true));
  await waitFor(() => expect(result.current.restoring).toBe(false));
  expect(mock.save).not.toHaveBeenCalled();
  mock.save.mockRejectedValueOnce(new Error('offline'));
  act(() => result.current.setCurrentId('a'));
  act(() => result.current.setCurrentId('b'));
  await waitFor(() => expect(mock.save).toHaveBeenLastCalledWith('b'));
});
