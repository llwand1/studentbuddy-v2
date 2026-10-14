import { Router } from 'express';
import { createHash } from 'node:crypto';
import { desktopGuard } from './desktop.js';
import { readerExtensionArchive } from '../desktop/extension-download.js';
export const desktopExtensionRouter = Router();
desktopExtensionRouter.get('/desktop-reader-extension.zip',desktopGuard,(_req,res)=>{
  try {
    const zip = readerExtensionArchive();
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename="StudentBuddy-reader-extension.zip"');
    res.setHeader('X-Content-SHA256',createHash('sha256').update(zip).digest('hex'));
    res.setHeader('Content-Length',zip.length); res.send(zip);
  } catch { res.status(503).json({error:'扩展文件不完整，请安装最新完整桌面版后重试下载'}); }
});
