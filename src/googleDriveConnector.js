// ─── Google Drive Source Connector ──────────────────────────────────────────
//
// Google Identity Services (OAuth token client) + Google Picker + Drive API
// v3. Config-gated: until a Google Cloud OAuth client is registered and
// VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY are supplied,
// isGoogleDriveConfigured() returns false and the UI shows a "not
// configured" message instead of a broken connect button.
//
// The Google SDK scripts are injected lazily (only when the Google Drive
// source tab is opened AND configured) — never at app startup.
//
// Produces the same normalized shape as folderScanUtils.js — { rootName,
// totalFolders, totalFiles, folderPaths, files: [{path, name, getFile}],
// unreadableFolders } — plus an additive `sourceMeta`. The access token
// never appears in the returned object and is never persisted beyond the
// current browser session.

const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

export function isGoogleDriveConfigured() {
  return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID && import.meta.env.VITE_GOOGLE_API_KEY)
}

let gisPromise = null
function ensureGisLoaded() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load Google Identity Services.'))
      document.head.appendChild(script)
    })
  }
  return gisPromise
}

let gapiPromise = null
function ensureGapiPickerLoaded() {
  if (window.google?.picker) return Promise.resolve()
  if (!gapiPromise) {
    gapiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://apis.google.com/js/api.js'
      script.async = true
      script.onload = () => {
        window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Could not load Google Picker.')) })
      }
      script.onerror = () => reject(new Error('Could not load Google API script.'))
      document.head.appendChild(script)
    })
  }
  return gapiPromise
}

// Requests a Drive read-only OAuth access token via a Google sign-in popup.
// The caller keeps the token in local component state only.
export async function requestAccessToken() {
  if (!isGoogleDriveConfigured()) {
    throw new Error('Google Drive is not configured. Set VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY (see .env.example).')
  }
  await ensureGisLoaded()
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) reject(new Error('Google Drive sign-in failed or was cancelled.'))
        else resolve(resp.access_token)
      },
    })
    tokenClient.requestAccessToken()
  })
}

// Opens the Google Picker scoped to folders. Resolves { id, name } of the
// chosen folder, or null if the user cancels.
export async function openPicker(accessToken) {
  await ensureGapiPickerLoaded()
  return new Promise((resolve, reject) => {
    try {
      const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(import.meta.env.VITE_GOOGLE_API_KEY)
        .setCallback((data) => {
          if (data.action === window.google.picker.Action.PICKED) {
            const doc = data.docs[0]
            resolve({ id: doc.id, name: doc.name })
          } else if (data.action === window.google.picker.Action.CANCEL) {
            resolve(null)
          }
        })
        .build()
      picker.setVisible(true)
    } catch (e) {
      reject(new Error('Could not open the Google Drive folder picker.'))
    }
  })
}

async function driveListChildren(folderId, accessToken) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  let res
  try {
    res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (e) {
    throw new Error('Could not reach Google Drive. Check your network connection and try again.')
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('Google Drive folder not found.')
    if (res.status === 401 || res.status === 403) throw new Error('Not authorized to access this Google Drive folder. Reconnect and try again.')
    throw new Error(`Google Drive request failed (HTTP ${res.status}).`)
  }
  const data = await res.json()
  return data.files || []
}

async function fetchDriveFile(file, accessToken) {
  let res
  try {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (e) {
    throw new Error(`Could not download "${file.name}" from Google Drive.`)
  }
  if (!res.ok) throw new Error(`Could not download "${file.name}" from Google Drive (HTTP ${res.status}).`)
  const blob = await res.blob()
  return new File([blob], file.name)
}

async function walkDriveTree(folderId, accessToken, pathSoFar, out) {
  const children = await driveListChildren(folderId, accessToken)
  for (const item of children) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      out.folderPaths.add([...pathSoFar, item.name].join('/'))
      await walkDriveTree(item.id, accessToken, [...pathSoFar, item.name], out)
    } else if (item.mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
      // Native Google Docs/Sheets/Slides aren't raw binary files — skipping
      // is a documented limitation (see plan §2), not exported via the v1
      // scope of this connector.
      out.skipped.push(item.name)
    } else {
      out.files.push({ path: pathSoFar, name: item.name, getFile: () => fetchDriveFile(item, accessToken) })
    }
  }
}

// Recursively scans a Google Drive folder (by ID, as returned from openPicker).
export async function scanGoogleDriveFolder({ folderId, folderName = 'Google Drive', accessToken }) {
  if (!folderId) throw new Error('Choose a Google Drive folder first.')
  if (!accessToken) throw new Error('Connect Google Drive first.')

  const out = { folderPaths: new Set(), files: [], skipped: [] }
  await walkDriveTree(folderId, accessToken, [], out)

  if (out.files.length === 0 && out.folderPaths.size === 0 && out.skipped.length === 0) {
    throw new Error('No files found in that Google Drive folder.')
  }

  return {
    rootName: folderName,
    totalFolders: out.folderPaths.size,
    totalFiles: out.files.length,
    folderPaths: [...out.folderPaths],
    files: out.files,
    unreadableFolders: 0,
    scanWarning: out.skipped.length
      ? `${out.skipped.length} native Google Docs/Sheets/Slides file(s) were skipped (export to PDF/Office format in Drive first, then re-scan): ${out.skipped.join(', ')}`
      : null,
    sourceMeta: { type: 'Google Drive', drive: 'My Drive', folderId, folderPath: folderName },
  }
}
