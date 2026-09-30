# StudentBuddy for Windows

Windows 10/11 x64 installer, with bundled Node runtime. The installer is identical to the corresponding [desktop Release](https://github.com/llwand1/studentbuddy-v2/releases).

For the simplest installation, download the `.exe` from the desktop Release and double-click it. No Node or npm is required.

For npm users, authenticate with GitHub Packages, then run:

```powershell
npm install --global @llwand1/studentbuddy-windows --registry=https://npm.pkg.github.com
studentbuddy-install
```

`studentbuddy-install --path` verifies the checksum and prints the bundled installer location. Installing this npm package does not run the installer automatically.

After installation, open StudentBuddy from the Start menu and configure your AI provider in Settings. The tray menu opens the app or quits its service. Upgrading and uninstalling preserve learning data. Use Windows Settings to uninstall StudentBuddy; `npm uninstall` removes only this distribution package.

The installer is currently unsigned. `SHA256SUMS.txt` records its SHA-256 checksum.
