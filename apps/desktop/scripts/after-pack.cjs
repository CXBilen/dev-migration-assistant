/* eslint-disable */
// electron-builder afterPack hook.
// When no signing identity is configured (contributor / unsigned alpha builds), apply an AD-HOC signature.
// Completely unsigned apps downloaded from the internet are reported by Gatekeeper as "damaged and can't be opened";
// ad-hoc-signed apps get the regular "unidentified developer → Open Anyway" flow instead.
// Signed release builds (CSC_LINK / identity configured) are left untouched: electron-builder signs them itself.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const hasIdentity =
    Boolean(process.env.CSC_LINK) ||
    Boolean(process.env.CSC_NAME) ||
    (context.packager.config.mac && context.packager.config.mac.identity) ||
    process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false'
  if (hasIdentity) return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  // --deep is sufficient for an ad-hoc signature over Electron's nested helpers/frameworks.
  // No --options runtime: hardened runtime + ad-hoc would enforce library validation against Apple-signed Electron frameworks.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], {
    stdio: 'inherit',
  })
  console.log(`  • ad-hoc signed  ${appName} (no signing identity configured)`)
}
