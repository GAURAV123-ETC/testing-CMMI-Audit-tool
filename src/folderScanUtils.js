// ─── Recursive Folder Scan Utilities ───────────────────────────────────────
//
// Full-depth traversal helpers for the Audit Folder & Document Availability
// validation flow (spec: "Do NOT scan only the root folder... search
// recursively through the complete uploaded folder structure").
//
// Two source adapters are provided, both normalizing to the same shape —
// { rootName, totalFolders, totalFiles, folderPaths, files } — because the
// two upload mechanisms already used elsewhere in this app (native
// showDirectoryPicker vs <input webkitdirectory>) expose folder structure
// differently:
//   - showDirectoryPicker gives a real, lazily-iterable directory tree, so
//     a genuinely empty folder CAN be detected and reported as AVAILABLE
//     with "no document found" rather than MISSING.
//   - <input webkitdirectory> only ever yields File objects (each carrying
//     a webkitRelativePath), so a folder with zero files in it is invisible
//     to the browser and can never be reported — a known platform
//     limitation of that API, not a bug in this code.
//
// `files` entries: { path: string[] (folder segments, root-relative, no
// filename), name, getFile: () => Promise<File> }.

export async function scanDirectoryHandle(dirHandle, rootNameHint) {
  const folderPaths = new Set()
  const files = []
  let totalFolders = 0
  let unreadableFolders = 0

  async function walk(handle, pathSoFar) {
    let iterator
    try {
      iterator = handle.values()
    } catch (_) {
      unreadableFolders += 1
      return
    }
    try {
      for await (const entry of iterator) {
        const entryPath = [...pathSoFar, entry.name]
        if (entry.kind === 'directory') {
          totalFolders += 1
          folderPaths.add(entryPath.join('/'))
          await walk(entry, entryPath)
        } else if (entry.kind === 'file') {
          files.push({ path: pathSoFar, name: entry.name, getFile: () => entry.getFile() })
        }
      }
    } catch (_) {
      unreadableFolders += 1
    }
  }

  await walk(dirHandle, [])
  return {
    rootName: rootNameHint || dirHandle.name || 'Uploaded folder',
    totalFolders, totalFiles: files.length, folderPaths: [...folderPaths], files, unreadableFolders,
  }
}

export function scanFileList(fileList, rootNameHint) {
  const folderPaths = new Set()
  const files = []
  let rootName = rootNameHint || 'Uploaded folder'

  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name
    const parts = rel.split('/').filter(Boolean)
    if (parts.length > 1) rootName = parts[0]
    const dirParts = parts.slice(1, -1) // exclude root segment + filename
    for (let i = 0; i < dirParts.length; i++) {
      folderPaths.add(dirParts.slice(0, i + 1).join('/'))
    }
    files.push({ path: dirParts, name: f.name, getFile: async () => f })
  }
  return { rootName, totalFolders: folderPaths.size, totalFiles: files.length, folderPaths: [...folderPaths], files, unreadableFolders: 0 }
}

// Boundary-safe folder-name matcher (e.g. "RSK", "RSK_Folder" match "RSK";
// "Risky" does not) — mirrors the same convention used elsewhere in this app
// (App.jsx matchesCode / validationEngine.js matchesCode) so folder-name
// recognition behaves consistently across every part of the codebase.
export function matchesFolderCode(name, code) {
  const upper = (name || '').toUpperCase().replace(/[_\-\s.]/g, '')
  const upperCode = (code || '').toUpperCase()
  return (
    upper === upperCode ||
    upper.startsWith(upperCode + '(') ||
    (upper.length > upperCode.length && upper.startsWith(upperCode) && !/[A-Z]/.test(upper[upperCode.length]))
  )
}

// Finds every folder path (anywhere in the tree, any depth) whose final
// segment matches `code`. Returns them shortest-path-first so the shallowest
// / most likely intended folder is treated as "the" match.
export function findFolderPathsForCode(scan, code) {
  const matches = scan.folderPaths.filter(p => {
    const segments = p.split('/')
    return matchesFolderCode(segments[segments.length - 1], code)
  })
  return matches.sort((a, b) => a.split('/').length - b.split('/').length)
}

// All files whose path lies at or under `folderPath` (a "/"-joined string
// as produced by findFolderPathsForCode), for Practice-Area drill-down.
export function filesUnderFolderPath(scan, folderPath) {
  const prefix = folderPath.split('/')
  return scan.files.filter(f => prefix.every((seg, i) => f.path[i] === seg))
}
