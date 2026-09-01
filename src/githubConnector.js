// ─── GitHub Source Connector ────────────────────────────────────────────────
//
// Fully client-side, no server, no OAuth app registration required. Public
// repositories work with an empty token; a Personal Access Token (entered
// per-session in the UI, never persisted) is only needed for private repos
// or to avoid GitHub's unauthenticated rate limit.
//
// Produces the same normalized shape as folderScanUtils.js's scanDirectoryHandle
// / scanFileList — { rootName, totalFolders, totalFiles, folderPaths, files:
// [{path, name, getFile}], unreadableFolders } — plus an additive `sourceMeta`
// (non-secret: owner/repo/branch/path only — the token itself never appears
// in the returned object).

const GITHUB_API = 'https://api.github.com'

// Accepts "owner/repo" or a full GitHub URL (with or without a trailing
// "/tree/branch/..." path, which is ignored — branch/path are separate
// fields in the UI).
export function parseGithubRepoInput(input) {
  if (!input) return null
  const trimmed = input.trim().replace(/\.git$/, '')
  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)/i)
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] }
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] }
  return null
}

function authHeaders(token, extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function githubJson(url, token) {
  let res
  try {
    res = await fetch(url, { headers: authHeaders(token) })
  } catch (e) {
    throw new Error('Could not reach GitHub. Check your network connection and try again.')
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('Repository, branch, or path not found — check the Repository, Branch and Folder/Path fields.')
    if (res.status === 403 || res.status === 429) throw new Error('GitHub API rate limit exceeded — add a Personal Access Token to continue, or try again later.')
    if (res.status === 401) throw new Error('GitHub authentication failed — check the Personal Access Token.')
    throw new Error(`GitHub request failed (HTTP ${res.status}).`)
  }
  return res.json()
}

async function fetchGithubBlobAsFile(owner, repo, sha, name, token) {
  let res
  try {
    res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${sha}`, {
      headers: authHeaders(token, { Accept: 'application/vnd.github.raw' }),
    })
  } catch (e) {
    throw new Error(`Could not reach GitHub while downloading "${name}".`)
  }
  if (!res.ok) throw new Error(`Could not download "${name}" from GitHub (HTTP ${res.status}).`)
  const blob = await res.blob()
  return new File([blob], name)
}

// Scans a repository (optionally scoped to a branch + folder/path) and
// returns the normalized scan shape. `token` is used only as a request
// header for this call — it is never included in the returned object.
export async function scanGithubRepo({ owner, repo, branch = 'main', path = '', token = '' }) {
  if (!owner || !repo) throw new Error('Enter a repository as "owner/repo" or a full GitHub URL.')
  const cleanBranch = (branch || 'main').trim()
  const cleanPath = (path || '').trim().replace(/^\/+|\/+$/g, '')

  const treeData = await githubJson(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(cleanBranch)}?recursive=1`,
    token,
  )
  if (!Array.isArray(treeData.tree)) {
    throw new Error('Repository, branch, or path not found — check the Repository, Branch and Folder/Path fields.')
  }

  const prefix = cleanPath ? cleanPath + '/' : ''
  const scoped = treeData.tree.filter(e => !prefix || e.path === cleanPath || e.path.startsWith(prefix))

  const folderPaths = new Set()
  const files = []
  scoped.forEach(e => {
    const rel = prefix ? e.path.slice(prefix.length) : e.path
    if (!rel) return
    if (e.type === 'tree') {
      folderPaths.add(rel)
    } else if (e.type === 'blob') {
      const parts = rel.split('/')
      const name = parts.pop()
      const dirParts = parts
      for (let i = 0; i < dirParts.length; i++) folderPaths.add(dirParts.slice(0, i + 1).join('/'))
      files.push({
        path: dirParts,
        name,
        getFile: () => fetchGithubBlobAsFile(owner, repo, e.sha, name, token),
      })
    }
  })

  if (files.length === 0 && folderPaths.size === 0) {
    throw new Error('No files found at that repository path. Check the Repository, Branch and Folder/Path fields.')
  }

  return {
    rootName: cleanPath ? cleanPath.split('/').pop() : repo,
    totalFolders: folderPaths.size,
    totalFiles: files.length,
    folderPaths: [...folderPaths],
    files,
    unreadableFolders: 0,
    scanWarning: treeData.truncated
      ? 'This repository is very large — GitHub truncated the file listing. Some files may be missing. Scope the Folder/Path field to a smaller subfolder for complete results.'
      : null,
    sourceMeta: { type: 'GitHub', owner, repo, branch: cleanBranch, path: cleanPath || '/' },
  }
}
