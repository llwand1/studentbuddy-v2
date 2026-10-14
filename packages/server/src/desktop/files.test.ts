import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const fixtures = path.resolve('.runtime'); fs.mkdirSync(fixtures, { recursive: true });
const base = fs.mkdtempSync(path.join(fixtures, 'sb-files-'));
process.env.SB_DATA_DIR = path.join(base, 'data'); process.env.SB_DESKTOP = '1'; process.env.SB_HOST = '127.0.0.1';
process.env.SB_DESKTOP_WORKSPACE_ROOT = path.join(base, 'workspace');
const { getDb, closeDb } = await import('../storage/db.js');
const { readComputerFile, writeWorkspaceFile, listComputerFiles, FILE_LIMIT } = await import('./files.js');
const { workspaceInfo, chooseWorkspace, protectPath, checkPathSyntax } = await import('./file-policy.js');
const { listFileApprovals, decideFileApproval, forgetRunFileApprovals } = await import('./file-approvals.js');
const ctx = { owner: null };
beforeEach(() => { getDb(); workspaceInfo(null); getDb().prepare('DELETE FROM desktop_file_approval').run(); getDb().prepare("DELETE FROM app_settings WHERE key='desktop.files.protected'").run(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); forgetRunFileApprovals('test-run'); });
afterAll(() => { closeDb(); delete process.env.SB_DESKTOP; delete process.env.SB_DESKTOP_WORKSPACE_ROOT; delete process.env.SB_HOST; if (path.dirname(base) !== fixtures) throw new Error('Fixture escaped test root'); fs.rmSync(base, { recursive: true, force: true }); });
it('computer files are readable but only the chosen workspace is writable', async () => {
  const outside = path.join(base, 'outside.txt'); fs.writeFileSync(outside, '普通资料');
  expect((await readComputerFile(ctx, outside)).text).toBe('普通资料');
  await expect(writeWorkspaceFile(ctx, outside, 'changed')).rejects.toThrow('只读');
  expect(fs.readFileSync(outside, 'utf8')).toBe('普通资料');
  await writeWorkspaceFile(ctx, 'notes/a.md', '# 学习笔记');
  expect((await readComputerFile(ctx, 'notes/a.md')).text).toBe('# 学习笔记');
  expect((await listComputerFiles(ctx, 'notes')).some(e => e.name === 'a.md')).toBe(true);
});
it('overwriting retains an original backup and readonly agents cannot write even inside the workspace', async () => {
  await writeWorkspaceFile(ctx, 'original.txt', 'old');
  const saved = await writeWorkspaceFile(ctx, 'original.txt', 'new'); expect(saved.backup).toBe(true);
  const backups = fs.readdirSync(path.join(base, 'data', 'file-backups'));
  expect(backups.some(p => fs.readFileSync(path.join(base, 'data', 'file-backups', p), 'utf8') === 'old')).toBe(true);
  await expect(writeWorkspaceFile({ owner: null, writeAllowed: false }, 'original.txt', 'bad')).rejects.toThrow('只读');
  expect((await readComputerFile(ctx, 'original.txt')).text).toBe('new');
});
it('sensitive paths do not open any file bytes before owner-bound one-time approval', async () => {
  const file = path.join(base, 'workspace', '.env'); fs.writeFileSync(file, 'private content');
  const open = vi.spyOn(fs, 'openSync');
  const pending = readComputerFile(ctx, '.env');
  const request = listFileApprovals(null)[0]!;
  expect(request.path).toBe(fs.realpathSync(file)); expect(open).not.toHaveBeenCalled();
  expect(decideFileApproval(request.id, 'other-user', true)).toBe(false);
  expect(decideFileApproval(request.id, null, true)).toBe(true);
  expect((await pending).text).toBe('private content');
  expect(decideFileApproval(request.id, null, true)).toBe(false);
  const again = readComputerFile(ctx, '.env'); expect(listFileApprovals(null)).toHaveLength(1);
  decideFileApproval(listFileApprovals(null)[0]!.id, null, false); await expect(again).rejects.toThrow('未批准');
});
it('credential-like text in an ordinary filename is withheld until approval', async () => {
  fs.writeFileSync(path.join(base, 'workspace', 'normal.txt'), 'api_key = example-secret-123');
  let resolved = false; const pending = readComputerFile(ctx, 'normal.txt').then(r => { resolved = true; return r; });
  await Promise.resolve(); expect(resolved).toBe(false);
  const a = listFileApprovals(null)[0]!; expect(a.reason).toContain('凭据');
  decideFileApproval(a.id, null, false); await expect(pending).rejects.toThrow('未批准');
});
it('denial cannot be retried by the same agent, including a canonical-path alias', async () => {
  const pending = readComputerFile({ owner: null, runId: 'test-run' }, '.env');
  decideFileApproval(listFileApprovals(null)[0]!.id, null, false); await expect(pending).rejects.toThrow('未批准');
  await expect(readComputerFile({ owner: null, runId: 'test-run' }, path.join(base, 'workspace', '.env'))).rejects.toThrow('不会再次申请');
  expect(listFileApprovals(null)).toHaveLength(0);
});
it('sensitive writes and timeout/abort never create files', async () => {
  const name = path.join(base, 'workspace', 'credentials.json');
  const pending = writeWorkspaceFile(ctx, name, 'private'); expect(fs.existsSync(name)).toBe(false);
  decideFileApproval(listFileApprovals(null)[0]!.id, null, false); await expect(pending).rejects.toThrow('未批准');
  const controller = new AbortController();
  const stopped = writeWorkspaceFile({ owner: null, signal: controller.signal }, name, 'private'); controller.abort();
  await expect(stopped).rejects.toThrow(); expect(fs.existsSync(name)).toBe(false);
  vi.useFakeTimers(); const timeout = writeWorkspaceFile(ctx, name, 'private'); const rejected = expect(timeout).rejects.toThrow('未批准');
  await vi.advanceTimersByTimeAsync(300001); await rejected; expect(fs.existsSync(name)).toBe(false);
});
it('custom sensitive directories apply to children and survive a database reopen', async () => {
  const dir = path.join(base, 'workspace', 'private'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'notes.txt'), '私人资料');
  protectPath(null, dir, true); closeDb(); expect(workspaceInfo(null).protectedPaths).toContain(dir);
  const pending = readComputerFile(ctx, path.join(dir, 'notes.txt')); expect(listFileApprovals(null)[0]!.reason).toContain('用户标记');
  decideFileApproval(listFileApprovals(null)[0]!.id, null, false); await expect(pending).rejects.toThrow();
});
it('symlink/junction writes cannot escape, including dangling junction targets', async () => {
  const outside = path.join(base, 'elsewhere'); fs.mkdirSync(outside, { recursive: true });
  const linked = path.join(base, 'workspace', 'linked'); fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(writeWorkspaceFile(ctx, 'linked/a.txt', 'no')).rejects.toThrow('链接'); expect(fs.existsSync(path.join(outside, 'a.txt'))).toBe(false);
  const missing = path.join(base, 'missing-dir'), broken = path.join(base, 'workspace', 'broken'); fs.symlinkSync(missing, broken, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(writeWorkspaceFile(ctx, 'broken/a.txt', 'no')).rejects.toThrow('链接'); expect(fs.existsSync(missing)).toBe(false);
});
it.each(['../outside.txt','C:relative.txt','C:\\dir\\file:stream','\\\\server\\share','\\\\?\\C:\\secret','NUL.txt'])('rejects ambiguous/device paths: %s', input => {
  expect(() => checkPathSyntax(input)).toThrow();
});
it('binary and large overwrite paths fail, while a large text read explicitly reports truncation', async () => {
  fs.writeFileSync(path.join(base, 'workspace', 'binary.bin'), Buffer.from([1, 0, 3]));
  await expect(readComputerFile(ctx, 'binary.bin')).rejects.toThrow('二进制');
  fs.writeFileSync(path.join(base, 'workspace', 'large.txt'), 'x'.repeat(FILE_LIMIT + 1));
  expect((await readComputerFile(ctx, 'large.txt')).truncated).toBe(true);
  await expect(writeWorkspaceFile(ctx, 'large.txt', 'tiny')).rejects.toThrow('另存');
});
it('changing workspace does not turn the previous folder writable, and hosted deployments cannot access files', async () => {
  const root = workspaceInfo(null).root, next = path.join(base, 'other-workspace'); fs.mkdirSync(next, { recursive: true });
  chooseWorkspace(null, next); await expect(writeWorkspaceFile(ctx, path.join(root, 'no.txt'), 'no')).rejects.toThrow('只读'); chooseWorkspace(null, root);
  process.env.SB_DESKTOP = '0'; await expect(readComputerFile(ctx, 'original.txt')).rejects.toThrow('本机'); process.env.SB_DESKTOP = '1';
});
