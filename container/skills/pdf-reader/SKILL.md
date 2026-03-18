---
name: pdf-reader
description: Read and extract text from PDF files using pdftotext CLI
---

# PDF Reader

You can read PDF files using the `pdftotext` command.

## Extract text from a PDF
```bash
pdftotext /workspace/group/documents/filename.pdf -
```

## Get PDF info (page count, metadata)
```bash
pdfinfo /workspace/group/documents/filename.pdf
```

## Extract specific pages
```bash
pdftotext -f 1 -l 5 /workspace/group/documents/filename.pdf -
```

## Notes
- PDFs sent via Telegram are downloaded to `/workspace/group/documents/`
- Image-based (scanned) PDFs will not have extractable text
- The `-` at the end outputs to stdout instead of creating a file
