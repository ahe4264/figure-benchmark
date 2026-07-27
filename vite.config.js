import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

function syncFiguresManifest() {
  const imagesDir = path.resolve(__dirname, 'public/images')
  const manifestPath = path.resolve(__dirname, 'public/figures.json')

  const figures = []
  for (const subject of fs.readdirSync(imagesDir)) {
    const subjectDir = path.join(imagesDir, subject)
    if (!fs.statSync(subjectDir).isDirectory()) continue
    for (const type of fs.readdirSync(subjectDir)) {
      const typeDir = path.join(subjectDir, type)
      if (!fs.statSync(typeDir).isDirectory()) continue
      for (const file of fs.readdirSync(typeDir)) {
        const ext = path.extname(file)
        if (!ext) continue
        if (subject === 'cs' && ext === '.svg') continue
        figures.push({ stem: path.basename(file, ext), subject, type, ext })
      }
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(figures, null, 2), 'utf8')
  console.log(`[figures] synced ${figures.length} figures to figures.json`)
  return figures.length
}

function figuresManifestPlugin() {
  return {
    name: 'figures-manifest',
    buildStart() { syncFiguresManifest() },
    configureServer(server) {
      syncFiguresManifest()
      server.watcher.add(path.resolve(__dirname, 'public/images'))
      server.watcher.on('add', f => { if (f.includes('public/images')) syncFiguresManifest() })
      server.watcher.on('unlink', f => { if (f.includes('public/images')) syncFiguresManifest() })
    },
  }
}

export default defineConfig({
  plugins: [figuresManifestPlugin(), react()],
})
