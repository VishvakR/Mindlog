# @mindlog/index-text

Keyword search for memory (PLAN 11.2).

## Public API

- `tokenize(text)` and `termCounts(text)`: Unicode words (`Intl.Segmenter`), lowercased, English stop words dropped, then Porter-stemmed (`stem`). Only ASCII words are stemmed.
- `bm25Score(tf, length, df, stats)`: BM25 with k1 = 1.2 and b = 0.75.
- `searchBm25(reader, terms, k)`: the top `k` documents over a `PostingReader` port (`stats`, `df`, `postings`).
- `encode/decodePosting`, `encode/decodeCount` and `encode/decodeStats`: fixed-width little-endian values for the stored postings, document frequencies and per-scope stats.

## Invariants

- The package knows no keys. The memory engine stores postings under `m/(user, 't', term, id)` (ADR-0031) and supplies the reader.
- Terms are computed by the proposing leader and carried in the command (ADR-0032). A tokenizer change therefore never makes replicas disagree.

Emits no metrics.
