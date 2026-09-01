// ─── SharePoint Source Connector ────────────────────────────────────────────
//
// Microsoft Graph API via MSAL (Authorization Code + PKCE — no client
// secret, safe for a browser-only SPA). Config-gated: until the org admin
// registers an Azure AD app and supplies VITE_SHAREPOINT_CLIENT_ID /
// VITE_SHAREPOINT_TENANT_ID, isSharePointConfigured() returns false and the
// UI shows a "not configured" message instead of a broken sign-in button.
//
// The MSAL client is constructed lazily (only on first use, never at module
// load) so an unconfigured deployment never touches MSAL at all.
//
// Produces the same normalized shape as folderScanUtils.js — { rootName,
// totalFolders, totalFiles, folderPaths, files: [{path, name, getFile}],
// unreadableFolders } — plus an additive `sourceMeta` (non-secret: site/
// library/path only — the access token never appears in the returned
// object and is never persisted beyond the current browser session).

const GRAPH_SCOPES = ['Sites.Read.All', 'Files.Read.All']

let msalInstance = null
let msalInitPromise = null

export function isSharePointConfigured() {
  return Boolean(import.meta.env.VITE_SHAREPOINT_CLIENT_ID && import.meta.env.VITE_SHAREPOINT_TENANT_ID)
}

async function getMsalInstance() {
  if (!isSharePointConfigured()) {
    throw new Error('SharePoint is not configured. Set VITE_SHAREPOINT_CLIENT_ID and VITE_SHAREPOINT_TENANT_ID (see .env.example).')
  }
  if (!msalInstance) {
    const { PublicClientApplication } = await import('@azure/msal-browser')
    msalInstance = new PublicClientApplication({
      auth: {
        clientId: import.meta.env.VITE_SHAREPOINT_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${import.meta.env.VITE_SHAREPOINT_TENANT_ID}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'sessionStorage' },
    })
  }
  if (!msalInitPromise) msalInitPromise = msalInstance.initialize()
  await msalInitPromise
  return msalInstance
}

// Opens the Microsoft sign-in popup. Returns { account, accessToken } — the
// caller keeps the token in local component state only.
export async function signIn() {
  const instance = await getMsalInstance()
  const result = await instance.loginPopup({ scopes: GRAPH_SCOPES })
  return { account: result.account, accessToken: result.accessToken }
}

export async function signOutSharePoint() {
  if (!msalInstance) return
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0]
  if (account) await msalInstance.logoutPopup({ account })
}

async function graphFetch(url, accessToken) {
  let res
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (e) {
    throw new Error('Could not reach Microsoft Graph. Check your network connection and try again.')
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('Site, library, or folder not found — check the Site, Document Library and Folder/Path fields.')
    if (res.status === 401 || res.status === 403) throw new Error('Not authorized to access this SharePoint site. Sign in again, or ask your admin to grant Sites.Read.All / Files.Read.All.')
    throw new Error(`SharePoint request failed (HTTP ${res.status}).`)
  }
  return res.json()
}

// siteUrl e.g. "https://contoso.sharepoint.com/sites/TeamSite"
export async function resolveSiteId(siteUrl, accessToken) {
  let u
  try {
    u = new URL(siteUrl.trim())
  } catch (e) {
    throw new Error('Enter a full SharePoint Site URL, e.g. https://yourtenant.sharepoint.com/sites/YourSite')
  }
  const data = await graphFetch(`https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname}`, accessToken)
  return data.id
}

async function resolveDriveId(siteId, driveName, accessToken) {
  const data = await graphFetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives`, accessToken)
  const drives = data.value || []
  const match = drives.find(d => (d.name || '').toLowerCase() === (driveName || 'Documents').toLowerCase()) || drives[0]
  if (!match) throw new Error('No document library found on this SharePoint site.')
  return match.id
}

async function fetchSharePointFile(item, accessToken) {
  const downloadUrl = item['@microsoft.graph.downloadUrl']
  let res
  try {
    res = downloadUrl
      ? await fetch(downloadUrl)
      : await fetch(`https://graph.microsoft.com/v1.0/drives/${item.parentReference.driveId}/items/${item.id}/content`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
  } catch (e) {
    throw new Error(`Could not download "${item.name}" from SharePoint.`)
  }
  if (!res.ok) throw new Error(`Could not download "${item.name}" from SharePoint (HTTP ${res.status}).`)
  const blob = await res.blob()
  return new File([blob], item.name)
}

async function walkDriveFolder(driveId, folderPath, accessToken, pathSoFar, out) {
  const encodedPath = folderPath ? `:/${folderPath.split('/').map(encodeURIComponent).join('/')}:` : ''
  const data = await graphFetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root${encodedPath}/children`, accessToken)
  for (const item of data.value || []) {
    if (item.folder) {
      out.folderPaths.add([...pathSoFar, item.name].join('/'))
      await walkDriveFolder(driveId, folderPath ? `${folderPath}/${item.name}` : item.name, accessToken, [...pathSoFar, item.name], out)
    } else if (item.file) {
      out.files.push({ path: pathSoFar, name: item.name, getFile: () => fetchSharePointFile(item, accessToken) })
    }
  }
}

// Scans a SharePoint document library folder (recursively). `accessToken`
// is used only as a request header for these calls — it is never included
// in the returned object.
export async function scanSharePointFolder({ siteUrl, driveName = 'Documents', folderPath = '', accessToken }) {
  if (!siteUrl) throw new Error('Enter the SharePoint Site URL.')
  if (!accessToken) throw new Error('Sign in to SharePoint first.')
  const siteId = await resolveSiteId(siteUrl, accessToken)
  const driveId = await resolveDriveId(siteId, driveName, accessToken)
  const cleanPath = (folderPath || '').trim().replace(/^\/+|\/+$/g, '')

  const out = { folderPaths: new Set(), files: [] }
  await walkDriveFolder(driveId, cleanPath, accessToken, [], out)

  if (out.files.length === 0 && out.folderPaths.size === 0) {
    throw new Error('No files found at that SharePoint folder. Check the Document Library and Folder/Path fields.')
  }

  return {
    rootName: cleanPath ? cleanPath.split('/').pop() : driveName,
    totalFolders: out.folderPaths.size,
    totalFiles: out.files.length,
    folderPaths: [...out.folderPaths],
    files: out.files,
    unreadableFolders: 0,
    sourceMeta: { type: 'SharePoint', siteUrl, driveName, folderPath: cleanPath || '/' },
  }
}
