# Datasheet / Document Intelligence

Cortex can import engineering documents (datasheets, reference manuals,
application notes) and answer questions against them with **citations** back to
the exact document, section, and line. This is engineering-context *retrieval*,
deliberately not "chat with a PDF": every result is a verbatim passage with real
provenance, and when nothing matches, the system says so rather than inventing a
value.

## Architecture

The subsystem follows the repo's pure-core / IO-shell split (the same shape as
`environment.ts` + `environmentService.ts`, and `agentContext.ts` +
`agentService.ts`):

```
src/shared/datasheet.ts        PURE: sectionizer, BM25 index + query, citation
                               formatter, hardware-graph query enrichment,
                               doc<->device matcher. No fs, no Electron.
src/main/services/datasheetService.ts   IO: import (copy into the corpus),
                               list, and search (parse -> index -> enrich ->
                               query). Owns the on-disk corpus + the index cache.
```

- **Corpus**: imported documents live in `<workspace>/.cortex/datasheets/`,
  tracked by a `manifest.json` there. A markdown/text file is copied verbatim; a
  PDF is extracted to a `<stem>.txt` (the revealable, line-addressable artifact)
  plus a `<stem>.sections.json` sidecar carrying page provenance. The stored text
  is the source of truth, so a citation opens it at its line.
- **PDF**: extracted by `pdfExtractor.ts` using **pdf2json** (a pure-JS,
  zero-native-dependency parser) - loaded lazily and declared an *optional*
  dependency, so a missing/broken install degrades to `isPdfAvailable()=false`
  and never blocks app start (the serialport/node-pty pattern). It reads the
  structured per-page text runs, rebuilds lines by their x/y coordinates, splits
  pages into blocks on vertical gaps. Parsing and reconstruction run in a
  disposable Node worker, not Electron's main thread. The main process enforces
  a 25-second wall deadline and waits for the worker to terminate on every
  outcome, including a CPU-stuck parser, malformed reply or exit without a
  result. Imports reject files above 20 MiB, more than 400 pages, text above
  8 MiB (the existing readable-document limit), or a serialized text/section
  result above 20 MiB; they do not silently truncate pages or store partial
  extraction. File size is checked before `loadPDF(file)`; it is not a locked
  snapshot of a file being edited concurrently. A
  scanned / image-only PDF has no text layer, so extraction yields nothing and
  reports it honestly - OCR is out of scope, empty is never dressed up as
  success. pdfjs-dist was avoided: its `Promise.withResolvers` needs Node 22,
  and Electron's Node is 20.
- **Worker limits**: the worker has a 256 MiB V8 old-generation heap limit.
  This is not a whole-process memory cap or a security sandbox: external buffers
  and total process memory are not bounded by Node's `resourceLimits`. OCR,
  faithful PDF layout rendering and recovery from global out-of-memory remain
  outside this text-extraction feature. The worker is emitted using
  [electron-vite's module-path import](https://electron-vite.org/guide/dev#multi-threading);
  its lifecycle uses the supported
  [Node 20 worker termination API](https://nodejs.org/download/release/v20.18.3/docs/api/worker_threads.html#workerterminate).
- **Retrieval**: a local **BM25** lexical index over the documents' sections. No
  embeddings and no network - offline, deterministic, and unable to make a claim
  it cannot back. The tokenizer keeps technical tokens whole (`0x68`, `GPIO5`,
  `TIM2`, `PA5`) because those are exactly what a datasheet query is about.
- **Provenance**: each section records the 1-based line it starts on, plus the
  1-based page for a PDF. A `DocCitation` carries doc name, section title, line,
  and optional page; `formatCitation` / `formatDocHits` render it identically
  everywhere.
- **Correlation**: `KnownDevice.key` from the hardware graph is the join key. At
  import, `matchDeviceForDoc` links a document to a device the project uses (by
  whole-token name match). At query, `enrichQueryFromGraph` adds the used
  devices' terms so "the I2C sensor" biases toward the right part's datasheet -
  additive terms only, never an asserted correlation.

## Surfaces

Retrieval reaches the engineer three ways, all through the one `formatDocHits`
formatter so citations render identically:

1. **Datasheets panel** (`DatasheetsPanel.tsx`): Import, a search box, results as
   cited passages (click to open the doc at the line), and the imported-document
   list with its linked device.
2. **Agent tool** `search_docs` (SAFE/read-only, auto-run): the engineering
   agent looks up register/timing/electrical facts and cites them instead of
   recalling from memory.
3. **Chat + structured fallback**: the last question's top passages are
   pre-injected into context (with citations) for providers without tool-calling.

## Security

- The corpus is confined to `<workspace>/.cortex/datasheets/` on the *physical*
  filesystem, not by a string prefix. The `manifest.json` and a PDF's sidecar
  travel with a cloned repo and are **untrusted**: a corpus read honors only the
  stored basename (forced into the corpus dir), rejects a symlink (`lstat`), and
  requires the corpus dir's realpath to stay inside the workspace - so a crafted
  manifest/sidecar cannot read `../etc/passwd`, an in-workspace secret, or a
  symlink target into the AI context.
- The **only** read of a path outside the workspace is the one user-chosen file
  at import, and that path comes from a native open dialog invoked in the **main
  process** (the `DATASHEET_IMPORT` handler) - never from the renderer or the AI.
- Stored names are sanitized (`safeName`); every corpus write is symlink-safe
  (refuses to write through a planted link) and confined to the realpath'd corpus
  dir. `LIST` and `QUERY` are root-gated like `ENV_INSPECT`.
- A non-PDF binary or oversized file is refused with an honest message; a PDF is
  routed to the extractor, and a malformed / no-text PDF fails cleanly rather
  than being parsed into garbage.

## Extension points

- **More formats**: add one extractor producing the same `DatasheetSection[]`
  shape (with `page`); the index, citations, IPC, and panel do not change - PDF
  (`pdfExtractor.ts`) is exactly such an adapter.
- **New device correlations**: add to `DEVICE_MAP` in `hardwareGraph.ts`;
  `KNOWN_DEVICES` and the doc matcher pick it up automatically.

## Testing

- `test/datasheet.test.ts` - the pure engine: tokenizer, sectionizers (line
  provenance), BM25 ranking + determinism + no-zero-score citations, citation
  formatting, enrichment, and the device matcher.
- `test/datasheetService.test.ts` - real IO: import copy + manifest + device
  link, binary refusal, malformed-PDF refusal, name sanitization, PDF import
  (`.txt` + sidecar + page-cited search), untrusted-manifest confinement, and
  cache invalidation on re-import.
- `test/pdfExtractor.test.ts` - real PDF extraction (pdf2json runs, no mock):
  page + line provenance, honest empty result for a no-text PDF, graceful failure
  on a malformed/missing file, and genuine 401-page / 20 MiB input rejection.
  `test/makePdf.ts` generates valid PDFs for both.
- `test/pdfWorker.test.ts` - real Node workers: the full 25-second CPU-loop
  watchdog with a responsive main-loop heartbeat, termination after success or
  failure, crashes, exit-without-result and malformed replies. Pure layout cases
  cover exact 8 MiB and 400-page boundaries, UTF-8 byte accounting, aggregate
  output limits and unchanged page/line provenance. Vitest builds the same worker
  source in owned Temp; only the build-time worker path is adapted, not its
  parser or lifecycle. Production dev/preview and packaged-installer validation
  are separate evidence, not inferred from these Node tests.
- `test/agentTools.test.ts` - `search_docs` is registered read-only.
