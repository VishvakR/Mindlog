---
description: Upload files to records, generate thumbnails, and serve protected files with short-lived tokens.
---

# Files

Add a `file` field to a collection and upload with `multipart/form-data`. Files are stored in the configured blob store; the record keeps their names.

## Upload

```ts
const form = new FormData();
form.append('title', 'receipt');
form.append('attachment', fileInput.files[0]);
const todo = await pb.collection('todos').create(form);
```

```bash
curl -s localhost:8090/api/collections/todos/records -H "Authorization: Bearer $TOKEN" \
  -F title=receipt -F attachment=@receipt.pdf -F user=$USER_ID
```

Field options: `maxSelect` (files per record), `maxSize` (default 5 MB), `mimeTypes`, `thumbs` and `protected`. Files are written to the blob store only after the create or update rule has passed. A janitor job removes blobs that no record references any more.

## Download

```
GET /api/files/:collection/:recordId/:filename
GET /api/files/:collection/:recordId/:filename?thumb=96x96
```

```ts
const url = pb.fileUrl(todo, todo.attachment, { thumb: '96x96' });
```

Thumbnail sizes must be listed in the field's `thumbs` option. `WxH` crops to fill, and a suffix `t`, `b` or `f` selects top crop, bottom crop or fit.

## Protected files

With `protected: true`, a download needs a short-lived **file token**, and the record's view rule is checked for the token's user:

```ts
const token = await pb.getFileToken();                    // POST /api/files/token
const url = pb.fileUrl(todo, todo.attachment, { token });
```

## Blob stores

```yaml
blob:
  default:
    type: local          # files under <dataDir>/blobs
    path: blobs
# or
blob:
  default:
    type: s3             # any S3-compatible store (AWS S3, MinIO, …)
    endpoint: https://s3.eu-central-1.amazonaws.com
    bucket: mindlog-files
    region: eu-central-1
    accessKeyId: ${file:/run/secrets/s3-key}
    secretAccessKey: ${file:/run/secrets/s3-secret}
```

The same store holds the memory cold tier and backups. With encryption at rest, blobs are encrypted with a per-tenant key.
