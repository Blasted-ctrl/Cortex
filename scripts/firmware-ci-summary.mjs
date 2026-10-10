import { appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function summaries(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await summaries(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (!summaryPath) {
  console.log('No GitHub job summary file; reports remain available in .cortex/.')
} else {
  const paths = [
    ...await summaries('.cortex/test-results'),
    ...await summaries('.cortex/selftest-results'),
    ...await summaries('.cortex/benchmarks'),
  ]
  const text = paths.length
    ? (await Promise.all(paths.map(path => readFile(path, 'utf8')))).join('\n\n')
    : 'No firmware reports were produced. Check the preceding build or runner error.\n'
  await appendFile(summaryPath, text)
}
